(function () {
  var key = 'accessible-terminal-session-id';
  var sessionId = '';
  try {
    sessionId = localStorage.getItem(key) || '';
    if (!sessionId) {
      sessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem(key, sessionId);
    }
  } catch (e) {
    sessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  window.accessibleTerminalSessionId = sessionId;
  window.accessibleTerminalWebSocketUrl = function () {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var mode = location.pathname.indexOf('console.html') >= 0 || location.pathname.indexOf('full-console.html') >= 0 ? 'full' : 'accessible';
    return protocol + '//' + location.host + '/ws?sessionId=' + encodeURIComponent(sessionId) + '&mode=' + mode;
  };

  // Existing terminal clients can continue constructing /ws normally. This
  // wrapper adds the shared session identifier without requiring each client
  // implementation to know about session routing.
  var NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;

  function SharedWebSocket(url, protocols) {
    var target = String(url || '');
    try {
      var parsed = new URL(target, window.location.href);
      if (parsed.pathname === '/ws') {
        parsed.searchParams.set('sessionId', sessionId);
        parsed.searchParams.set('mode', location.pathname.indexOf('console.html') >= 0 || location.pathname.indexOf('full-console.html') >= 0 ? 'full' : 'accessible');
        target = parsed.toString();
      }
    } catch (e) {}
    if (arguments.length > 1) return new NativeWebSocket(target, protocols);
    return new NativeWebSocket(target);
  }

  SharedWebSocket.prototype = NativeWebSocket.prototype;
  SharedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  SharedWebSocket.OPEN = NativeWebSocket.OPEN;
  SharedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  SharedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  window.WebSocket = SharedWebSocket;
})();
