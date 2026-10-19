// Landing page: live status from /healthz (same origin) and the connect command.
// No secrets, no third-party requests (CSP: connect-src 'self').
(function () {
  'use strict';

  var origin = window.location.origin;
  var endpoint = origin + '/mcp';
  var command =
    'claude mcp add --transport http nightshift ' +
    endpoint +
    ' --header "Authorization: Bearer <your-token>"';

  document.getElementById('endpoint').textContent = endpoint;
  document.getElementById('cmd').textContent = command;

  var status = document.getElementById('status');
  var statusText = document.getElementById('status-text');
  function setStatus(state, text) {
    status.setAttribute('data-state', state);
    statusText.textContent = text;
  }

  function check() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, 8000);
    fetch('/healthz', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) {
        return r.ok ? r.text() : '';
      })
      .then(function (body) {
        if (body.trim() === 'ok') setStatus('ok', 'Operational');
        else setStatus('down', 'Unreachable');
      })
      .catch(function () {
        setStatus('down', 'Unreachable');
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }
  check();
  setInterval(check, 60000);

  var copied = document.getElementById('copied');
  document.getElementById('copy').addEventListener('click', function () {
    if (!navigator.clipboard) {
      copied.textContent = 'Select the command and copy it.';
      return;
    }
    navigator.clipboard.writeText(command).then(
      function () {
        copied.textContent = 'Copied. Replace <your-token> with your token.';
      },
      function () {
        copied.textContent = 'Select the command and copy it.';
      },
    );
  });
})();
