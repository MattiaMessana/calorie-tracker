(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  var goalValue = $('#goal-value');
  var consumedValue = $('#consumed-value');
  var remainingValue = $('#remaining-value');
  var cardRemaining = $('#card-remaining');
  var progressBar = $('#progress-bar');
  var ringFill = $('#ring-fill');
  var entriesList = $('#entries-list');
  var emptyMsg = $('#empty-msg');

  var goalForm = $('#goal-form');
  var goalInput = $('#goal-input');
  var entryForm = $('#entry-form');
  var mealSelect = $('#meal-select');
  var descInput = $('#desc-input');
  var kcalInput = $('#kcal-input');
  var resetBtn = $('#reset-btn');

  // Force numeric-only on text inputs with inputmode=numeric
  [goalInput, kcalInput].forEach(function (input) {
    if (!input) return;
    input.addEventListener('input', function () {
      this.value = this.value.replace(/[^0-9]/g, '');
    });
  });

  // SVG ring gradient
  var svgEl = document.querySelector('.ring-svg');
  if (svgEl) {
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    var grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    grad.setAttribute('id', 'ring-gradient');
    grad.setAttribute('x1', '0%');
    grad.setAttribute('y1', '0%');
    grad.setAttribute('x2', '100%');
    grad.setAttribute('y2', '0%');
    var stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', '#8b5cf6');
    var stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', '#6366f1');
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);
    svgEl.insertBefore(defs, svgEl.firstChild);
  }

  var RING_CIRCUMFERENCE = 2 * Math.PI * 52;

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function (r) { return r.json(); });
  }

  function animateValue(el, start, end, duration) {
    if (start === end) { el.textContent = end; return; }
    var range = end - start;
    var startTime = null;
    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(start + range * eased);
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var prevGoal = 0, prevConsumed = 0, prevRemaining = 0;

  function render(state) {
    var goalKcal = state.goalKcal;
    var entries = state.entries;
    var totals = state.totals;

    animateValue(goalValue, prevGoal, goalKcal, 500);
    animateValue(consumedValue, prevConsumed, totals.consumed, 500);
    animateValue(remainingValue, prevRemaining, totals.remaining, 500);
    prevGoal = goalKcal;
    prevConsumed = totals.consumed;
    prevRemaining = totals.remaining;

    var exceeded = totals.remaining < 0;
    cardRemaining.classList.toggle('exceeded', exceeded);
    if (progressBar) progressBar.classList.toggle('exceeded', exceeded);

    var pct = goalKcal > 0 ? Math.min((totals.consumed / goalKcal) * 100, 100) : 0;
    if (progressBar) progressBar.style.width = pct + '%';

    if (ringFill) {
      var offset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
      ringFill.style.strokeDashoffset = offset;
      ringFill.classList.toggle('exceeded', exceeded);
    }

    var pctLabel = document.getElementById('progress-pct');
    if (pctLabel) pctLabel.textContent = Math.round(pct) + '%';

    goalInput.placeholder = goalKcal || '2200';

    entriesList.innerHTML = '';
    emptyMsg.style.display = entries.length === 0 ? '' : 'none';

    var mealEmoji = {
      colazione: '\u2600\uFE0F',
      pranzo: '\uD83C\uDF5D',
      cena: '\uD83C\uDF19',
      spuntino: '\uD83C\uDF4E',
    };

    var mealLabels = {
      colazione: 'Colazione',
      pranzo: 'Pranzo',
      cena: 'Cena',
      spuntino: 'Spuntino',
    };

    entries.forEach(function (entry, i) {
      var item = document.createElement('div');
      item.className = 'entry-item';
      item.style.animationDelay = (i * 0.05) + 's';
      var emoji = mealEmoji[entry.meal] || '';
      item.innerHTML =
        '<div class="entry-info">' +
          '<span class="entry-meal">' + emoji + ' ' + escapeHtml(mealLabels[entry.meal] || entry.meal) + '</span>' +
          '<span class="entry-desc">' + escapeHtml(entry.description) + '</span>' +
        '</div>' +
        '<div class="entry-right">' +
          '<span class="entry-kcal">' + entry.kcal + ' kcal</span>' +
          '<button class="entry-delete" data-id="' + escapeHtml(entry.id) + '">&times;</button>' +
        '</div>';
      entriesList.appendChild(item);
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function loadState() {
    api('GET', '/api/state').then(render);
  }

  goalForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var val = goalInput.value.trim();
    if (!val || isNaN(val) || Number(val) < 1) return;
    api('POST', '/api/goal', { goalKcal: Number(val) }).then(function (data) {
      if (data.error) return alert(data.error);
      goalInput.value = '';
      render(data);
    });
  });

  entryForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var meal = mealSelect.value;
    var description = descInput.value.trim();
    var kcal = kcalInput.value.trim();
    if (!meal || !description || !kcal || isNaN(kcal) || Number(kcal) < 1) return;
    api('POST', '/api/entries', { meal: meal, description: description, kcal: Number(kcal) }).then(function (data) {
      if (data.error) return alert(data.error);
      mealSelect.value = '';
      descInput.value = '';
      kcalInput.value = '';
      render(data);
    });
  });

  entriesList.addEventListener('click', function (e) {
    if (!e.target.classList.contains('entry-delete')) return;
    var id = e.target.getAttribute('data-id');
    if (!confirm('Eliminare questa voce?')) return;
    api('DELETE', '/api/entries?id=' + encodeURIComponent(id)).then(function (data) {
      if (data.error) return alert(data.error);
      render(data);
    });
  });

  resetBtn.addEventListener('click', function () {
    if (!confirm('Cancellare tutti i pasti di oggi?')) return;
    api('POST', '/api/reset').then(function (data) {
      if (data.error) return alert(data.error);
      render(data);
    });
  });

  loadState();
})();
