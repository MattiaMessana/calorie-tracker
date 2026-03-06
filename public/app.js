(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const goalValue = $('#goal-value');
  const consumedValue = $('#consumed-value');
  const remainingValue = $('#remaining-value');
  const cardRemaining = $('#card-remaining');
  const progressBar = $('#progress-bar');
  const entriesList = $('#entries-list');
  const emptyMsg = $('#empty-msg');

  const goalForm = $('#goal-form');
  const goalInput = $('#goal-input');
  const entryForm = $('#entry-form');
  const mealSelect = $('#meal-select');
  const descInput = $('#desc-input');
  const kcalInput = $('#kcal-input');
  const resetBtn = $('#reset-btn');

  // --- API calls ---

  function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then((r) => r.json());
  }

  // --- Render ---

  function render(state) {
    const { goalKcal, entries, totals } = state;

    goalValue.textContent = goalKcal;
    consumedValue.textContent = totals.consumed;
    remainingValue.textContent = totals.remaining;

    const exceeded = totals.remaining < 0;
    cardRemaining.classList.toggle('exceeded', exceeded);
    progressBar.classList.toggle('exceeded', exceeded);

    const pct = goalKcal > 0 ? Math.min((totals.consumed / goalKcal) * 100, 100) : 0;
    progressBar.style.width = pct + '%';

    var pctLabel = document.getElementById('progress-pct');
    if (pctLabel) pctLabel.textContent = Math.round(pct) + '%';

    goalInput.placeholder = goalKcal;

    // Entries list
    entriesList.innerHTML = '';
    emptyMsg.style.display = entries.length === 0 ? 'block' : 'none';

    const mealLabels = {
      colazione: 'Colazione',
      pranzo: 'Pranzo',
      cena: 'Cena',
      spuntino: 'Spuntino',
    };

    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'entry-item';
      item.innerHTML =
        '<div class="entry-info">' +
          '<span class="entry-meal">' + escapeHtml(mealLabels[entry.meal] || entry.meal) + '</span>' +
          '<span class="entry-desc">' + escapeHtml(entry.description) + '</span>' +
        '</div>' +
        '<div class="entry-right">' +
          '<span class="entry-kcal">' + entry.kcal + ' kcal</span>' +
          '<button class="entry-delete" data-id="' + escapeHtml(entry.id) + '">Elimina</button>' +
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

  // --- Events ---

  goalForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var val = goalInput.value.trim();
    if (!val) return;
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
    if (!meal || !description || !kcal) return;
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

  // --- Init ---
  loadState();
})();
