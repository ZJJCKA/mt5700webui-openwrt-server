'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourceRoot = path.resolve(__dirname, '..');
const webRoot = path.join(
  sourceRoot, 'at-webserver', 'files', 'www', '5700'
);
const guardPath = path.join(webRoot, 'scripts', 'session-guard.js');
const guardSource = fs.readFileSync(guardPath, 'utf8');

function createHarness() {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervals = [];
  const sockets = [];
  const storage = new Map([
    ['at_ws_auth_key', 'secret'],
    ['at_ws_auth_key_expiry', '9999999999999']
  ]);
  let reloadCount = 0;

  function addListener(registry, type, listener) {
    if (!registry.has(type)) {
      registry.set(type, []);
    }
    registry.get(type).push(listener);
  }

  function dispatch(registry, type, event) {
    (registry.get(type) || []).slice().forEach((listener) => listener(event));
  }

  function createElement(tagName) {
    const listeners = new Map();
    return {
      tagName: tagName.toUpperCase(),
      id: '',
      type: '',
      textContent: '',
      children: [],
      style: { cssText: '', margin: '' },
      setAttribute() {},
      addEventListener(type, listener) {
        addListener(listeners, type, listener);
      },
      appendChild(child) {
        this.children.push(child);
        if (child.id) {
          elements.set(child.id, child);
        }
        return child;
      },
      dispatch(type, event = {}) {
        dispatch(listeners, type, event);
      }
    };
  }

  const body = createElement('body');
  const document = {
    body,
    documentElement: createElement('html'),
    visibilityState: 'visible',
    createElement,
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener(type, listener) {
      addListener(documentListeners, type, listener);
    }
  };

  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      this.closeCalls = [];
      sockets.push(this);
    }

    addEventListener(type, listener) {
      addListener(this.listeners, type, listener);
    }

    dispatch(type, details = {}) {
      let stopped = false;
      const event = Object.assign({}, details, {
        stopImmediatePropagation() {
          stopped = true;
        }
      });
      for (const listener of (this.listeners.get(type) || []).slice()) {
        listener(event);
        if (stopped) {
          return;
        }
      }
      const propertyHandler = this[`on${type}`];
      if (propertyHandler) {
        propertyHandler(event);
      }
    }

    close(code, reason) {
      this.closeCalls.push([code, reason]);
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch('close', { code, reason });
    }

    send() {}
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  function nativeSetInterval(callback, delay) {
    intervals.push({ callback, delay });
    return intervals.length;
  }

  const context = {
    Array,
    DOMException,
    Error,
    Object,
    WebSocket: FakeWebSocket,
    clearInterval() {},
    console,
    document,
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      removeItem(key) { storage.delete(key); },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    location: {
      reload() { reloadCount += 1; }
    },
    setInterval: nativeSetInterval
  };
  context.window = context;
  context.addEventListener = function (type, listener) {
    addListener(windowListeners, type, listener);
  };
  context.window.addEventListener = context.addEventListener;

  vm.createContext(context);
  vm.runInContext(guardSource, context, { filename: guardPath });

  return {
    context,
    document,
    dispatchWindow(type, event = {}) {
      dispatch(windowListeners, type, event);
    },
    elements,
    intervals,
    reloadCount: () => reloadCount,
    sockets,
    storage
  };
}

function testTakeoverStopsReconnectAndClearsAuth() {
  const harness = createHarness();
  const socket = new harness.context.WebSocket('ws://router.lan:8765');
  let bundledOnCloseCount = 0;
  socket.onclose = function () {
    bundledOnCloseCount += 1;
  };

  socket.dispatch('close', {
    code: 4001,
    reason: 'replaced_by_new_session'
  });

  assert.strictEqual(bundledOnCloseCount, 0);
  assert.strictEqual(harness.storage.has('at_ws_auth_key'), false);
  assert.strictEqual(harness.storage.has('at_ws_auth_key_expiry'), false);
  assert.ok(harness.elements.has('at-session-taken-over'));
  assert.strictEqual(harness.context.__AT_SESSION_GUARD__.isTakenOver(), true);
  assert.throws(
    () => new harness.context.WebSocket('ws://router.lan:8765'),
    /replaced by a newer page/
  );
}

function testHiddenPagePausesIntervalsAndMessages() {
  const harness = createHarness();
  let intervalCount = 0;
  let messageCount = 0;
  harness.context.setInterval(function () {
    intervalCount += 1;
  }, 1000);
  const socket = new harness.context.WebSocket('ws://router.lan:8765');
  socket.onmessage = function () {
    messageCount += 1;
  };

  harness.document.visibilityState = 'hidden';
  harness.intervals[0].callback();
  socket.dispatch('message', {
    data: JSON.stringify({ success: true, message: '认证成功' })
  });
  assert.strictEqual(intervalCount, 0);
  assert.strictEqual(messageCount, 1);

  socket.dispatch('message', { data: 'hidden-after-auth' });
  assert.strictEqual(messageCount, 1);

  harness.document.visibilityState = 'visible';
  harness.intervals[0].callback();
  socket.dispatch('message', { data: 'visible' });
  assert.strictEqual(intervalCount, 1);
  assert.strictEqual(messageCount, 2);
}

function testPageHideOnlyClosesBrowserSocket() {
  const harness = createHarness();
  const socket = new harness.context.WebSocket('ws://router.lan:8765');
  let bundledOnCloseCount = 0;
  socket.onclose = function () {
    bundledOnCloseCount += 1;
  };

  harness.dispatchWindow('pagehide');

  assert.deepStrictEqual(socket.closeCalls, [[1000, 'page_hidden']]);
  assert.strictEqual(bundledOnCloseCount, 0);
  assert.strictEqual(harness.storage.get('at_ws_auth_key'), 'secret');
  assert.strictEqual(
    harness.storage.get('at_ws_auth_key_expiry'), '9999999999999'
  );
}

function findIndexFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...findIndexFiles(fullPath));
    } else if (entry.name === 'index.html') {
      found.push(fullPath);
    }
  }
  return found;
}

function testEveryEntryLoadsGuardBeforeUmi() {
  const indexFiles = findIndexFiles(webRoot);
  assert.strictEqual(indexFiles.length, 12);
  for (const indexFile of indexFiles) {
    const html = fs.readFileSync(indexFile, 'utf8');
    const guardMarker = '/5700/scripts/session-guard.js';
    const umiMarker = '/5700/umi.03797ca7.js?v=31';
    assert.strictEqual(html.split(guardMarker).length - 1, 1, indexFile);
    assert.ok(html.indexOf(guardMarker) < html.indexOf(umiMarker), indexFile);
  }
}

testTakeoverStopsReconnectAndClearsAuth();
testHiddenPagePausesIntervalsAndMessages();
testPageHideOnlyClosesBrowserSocket();
testEveryEntryLoadsGuardBeforeUmi();
console.log('PASS: AT WebUI latest-session browser guard contract');
