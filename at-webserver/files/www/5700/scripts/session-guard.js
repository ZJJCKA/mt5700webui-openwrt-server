/* Keep exactly one active AT WebUI browser session without touching at-server. */
(function () {
  'use strict';

  if (window.__AT_SESSION_GUARD__) {
    return;
  }

  var NativeWebSocket = window.WebSocket;
  var nativeSetInterval = window.setInterval;
  var sockets = [];
  var takenOver = false;
  var leaving = false;

  function isPaused() {
    return takenOver || leaving || document.visibilityState !== 'visible';
  }

  function forgetSocket(socket) {
    var index = sockets.indexOf(socket);
    if (index !== -1) {
      sockets.splice(index, 1);
    }
  }

  function clearPluginAuth() {
    try {
      localStorage.removeItem('at_ws_auth_key');
      localStorage.removeItem('at_ws_auth_key_expiry');
    } catch (error) {
      /* Storage can be unavailable in privacy mode; takeover still applies. */
    }
  }

  function renderTakenOver() {
    function render() {
      if (!document.body || document.getElementById('at-session-taken-over')) {
        return;
      }

      var overlay = document.createElement('div');
      overlay.id = 'at-session-taken-over';
      overlay.setAttribute('role', 'alert');
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px',
        'box-sizing:border-box',
        'background:#f5f5f5',
        'color:#1f1f1f',
        'font-family:Arial,sans-serif',
        'text-align:center'
      ].join(';');

      var panel = document.createElement('div');
      panel.style.cssText = [
        'max-width:460px',
        'padding:28px',
        'border-radius:10px',
        'background:#fff',
        'box-shadow:0 8px 30px rgba(0,0,0,.15)'
      ].join(';');

      var title = document.createElement('h2');
      title.textContent = '此页面已退出';
      title.style.margin = '0 0 12px';

      var message = document.createElement('p');
      message.textContent = 'AT 插件已在另一台设备或新页面打开，本页面已停止刷新。';
      message.style.margin = '0 0 20px';

      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = '重新登录并接管';
      button.style.cssText = [
        'border:0',
        'border-radius:6px',
        'padding:10px 18px',
        'background:#1677ff',
        'color:#fff',
        'font-size:14px',
        'cursor:pointer'
      ].join(';');
      button.addEventListener('click', function () {
        window.location.reload();
      });

      panel.appendChild(title);
      panel.appendChild(message);
      panel.appendChild(button);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    }

    if (document.body) {
      render();
    } else {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    }
  }

  function markTakenOver() {
    if (takenOver) {
      return;
    }
    takenOver = true;
    clearPluginAuth();
    renderTakenOver();
  }

  function blockedWebSocketError() {
    try {
      return new DOMException(
        'This AT WebUI session was replaced by a newer page.',
        'InvalidStateError'
      );
    } catch (error) {
      return new Error('This AT WebUI session was replaced by a newer page.');
    }
  }

  function GuardedWebSocket(url, protocols) {
    if (takenOver || leaving) {
      throw blockedWebSocketError();
    }

    var socket = arguments.length > 1
      ? new NativeWebSocket(url, protocols)
      : new NativeWebSocket(url);
    var firstMessageSeen = false;
    sockets.push(socket);

    /* Registered before the bundled client assigns onclose/onmessage. */
    socket.addEventListener('close', function (event) {
      forgetSocket(socket);
      if (event.code === 4001) {
        event.stopImmediatePropagation();
        markTakenOver();
      } else if (leaving) {
        event.stopImmediatePropagation();
      }
    });

    socket.addEventListener('message', function (event) {
      var isFirstMessage = !firstMessageSeen;
      firstMessageSeen = true;
      /* With auth enabled, the first server frame is the auth result.  Let it
       * settle Umi's connect promise even if the tab was hidden immediately. */
      if (isFirstMessage && !takenOver && !leaving) {
        return;
      }
      if (isPaused()) {
        event.stopImmediatePropagation();
      }
    });

    return socket;
  }

  GuardedWebSocket.prototype = NativeWebSocket.prototype;
  if (Object.setPrototypeOf) {
    Object.setPrototypeOf(GuardedWebSocket, NativeWebSocket);
  }
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (name) {
    Object.defineProperty(GuardedWebSocket, name, {
      configurable: false,
      enumerable: true,
      value: NativeWebSocket[name],
      writable: false
    });
  });
  window.WebSocket = GuardedWebSocket;

  window.setInterval = function (callback, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof callback !== 'function') {
      return nativeSetInterval.apply(window, arguments);
    }
    return nativeSetInterval(function () {
      if (!isPaused()) {
        callback.apply(window, args);
      }
    }, delay);
  };

  window.addEventListener('pagehide', function () {
    leaving = true;
    sockets.slice().forEach(function (socket) {
      if (
        socket.readyState === NativeWebSocket.CONNECTING ||
        socket.readyState === NativeWebSocket.OPEN
      ) {
        try {
          socket.close(1000, 'page_hidden');
        } catch (error) {
          /* The browser will finish closing the page-owned socket. */
        }
      }
    });
  });

  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      window.location.reload();
    }
  });

  window.__AT_SESSION_GUARD__ = {
    isPaused: isPaused,
    isTakenOver: function () { return takenOver; }
  };
})();
