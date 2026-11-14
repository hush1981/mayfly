// Draws the QR codes as SVG (no network, no innerHTML). Without JavaScript the links still work.
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  function draw(fig) {
    var raw = fig.getAttribute('data-qr-raw');
    var url = raw || new URL(fig.getAttribute('data-qr'), location.href).href;
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    var n = qr.getModuleCount();
    var d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z';
      }
    }
    var svg = document.createElementNS(NS, 'svg');
    // 4-module quiet zone, as the QR spec asks for
    svg.setAttribute('viewBox', '-4 -4 ' + (n + 8) + ' ' + (n + 8));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', raw ? 'Mayfly-Freundescode' : 'QR-Code: ' + url);
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.appendChild(path);
    fig.insertBefore(svg, fig.firstChild);
    if (!raw) fig.title = url;
    fig.classList.add('ready');
  }

  var figs = document.querySelectorAll('[data-qr], [data-qr-raw]');
  for (var i = 0; i < figs.length; i++) {
    try { draw(figs[i]); } catch (e) { /* leave the figure hidden */ }
  }
})();
