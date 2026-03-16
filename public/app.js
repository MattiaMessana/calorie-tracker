(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return document.querySelectorAll(sel); };
  var csrfToken = '';

  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { window.location.href = '/login'; return; }
      csrfToken = data.csrfToken || '';
      initApp(data.user);
    })
    .catch(function () { window.location.href = '/login'; });

  function initApp(currentUser) {
    // Elements
    var goalValue = $('#goal-value');
    var consumedValue = $('#consumed-value');
    var remainingValue = $('#remaining-value');
    var cardRemaining = $('#card-remaining');
    var progressBar = $('#progress-bar');
    var ringFill = $('#ring-fill');
    var entriesList = $('#entries-list');
    var emptyMsg = $('#empty-msg');
    var selectedMeal = 'pranzo';
    var resetBtn = $('#reset-btn');
    var logoutBtn = $('#logout-btn');
    var userNameEl = $('#user-name');
    var entriesBadge = $('#entries-badge');

    // Chat
    var chatForm = $('#chat-form');
    var chatInput = $('#chat-input');
    var chatMessages = $('#pepis-messages');
    var chatSend = $('#chat-send');
    var pepisWelcome = $('#pepis-welcome');
    var mealChipsContainer = $('#meal-chips');

    // Goal modal
    var goalModal = $('#goal-modal');
    var goalForm = $('#goal-form');
    var goalInput = $('#goal-input');
    var goalBtn = $('#goal-btn');
    var goalCancel = $('#goal-cancel');

    var isWaiting = false;

    // User info
    var name = currentUser.displayName || currentUser.username;
    if (userNameEl) userNameEl.textContent = name;
    var avatarEl = $('#user-avatar');
    if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();

    // SVG ring gradient
    var svgEl = document.querySelector('.ring-svg');
    if (svgEl) {
      var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      var grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
      grad.setAttribute('id', 'ring-gradient');
      grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
      grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '0%');
      var s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#8b5cf6');
      var s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#6366f1');
      grad.appendChild(s1); grad.appendChild(s2);
      defs.appendChild(grad); svgEl.insertBefore(defs, svgEl.firstChild);
    }

    var RING_CIRCUMFERENCE = 2 * Math.PI * 52;

    // ============================================================
    // Tab navigation
    // ============================================================
    var tabBtns = $$('.tab-btn');
    var tabPanels = $$('.tab-panel');

    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        tabBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        tabPanels.forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + tab); });
      });
    });

    // ============================================================
    // Goal modal
    // ============================================================
    goalBtn.addEventListener('click', function () { goalModal.classList.add('open'); goalInput.focus(); });
    goalCancel.addEventListener('click', function () { goalModal.classList.remove('open'); });
    goalModal.addEventListener('click', function (e) { if (e.target === goalModal) goalModal.classList.remove('open'); });

    goalForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = goalInput.value.trim();
      if (!val || isNaN(val) || Number(val) < 1) return;
      api('POST', '/api/goal', { goalKcal: Number(val) }).then(function (data) {
        if (data && !data.error) { render(data); goalModal.classList.remove('open'); goalInput.value = ''; }
      });
    });

    if (goalInput) {
      goalInput.addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '');
      });
    }

    // ============================================================
    // API helper
    // ============================================================
    function api(method, apiPath, body) {
      var headers = { 'Content-Type': 'application/json' };
      if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
      var opts = { method: method, headers: headers };
      if (body) opts.body = JSON.stringify(body);
      return fetch(apiPath, opts).then(function (r) {
        if (r.status === 401) { window.location.href = '/login'; return Promise.reject(new Error('Auth')); }
        if (r.status === 403) {
          return r.json().then(function (d) {
            if (d.error && d.error.indexOf('CSRF') !== -1) {
              return fetch('/api/me').then(function (r2) { return r2.json(); }).then(function (me) {
                if (me.csrfToken) csrfToken = me.csrfToken;
                return Promise.reject(new Error('CSRF'));
              });
            }
            return d;
          });
        }
        return r.json();
      });
    }

    // ============================================================
    // Render state
    // ============================================================
    function animateValue(el, start, end, dur) {
      if (start === end) { el.textContent = end; return; }
      var range = end - start; var t0 = null;
      function step(ts) {
        if (!t0) t0 = ts;
        var p = Math.min((ts - t0) / dur, 1);
        el.textContent = Math.round(start + range * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    var prev = { goal: 0, consumed: 0, remaining: 0 };

    function render(state) {
      var g = state.goalKcal, entries = state.entries, t = state.totals;

      animateValue(goalValue, prev.goal, g, 400);
      animateValue(consumedValue, prev.consumed, t.consumed, 400);
      animateValue(remainingValue, prev.remaining, t.remaining, 400);
      prev = { goal: g, consumed: t.consumed, remaining: t.remaining };

      var exceeded = t.remaining < 0;
      cardRemaining.classList.toggle('exceeded', exceeded);
      if (progressBar) progressBar.classList.toggle('exceeded', exceeded);

      var pct = g > 0 ? Math.min((t.consumed / g) * 100, 100) : 0;
      if (progressBar) progressBar.style.width = pct + '%';
      if (ringFill) {
        ringFill.style.strokeDashoffset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
        ringFill.classList.toggle('exceeded', exceeded);
      }
      var pctLabel = document.getElementById('progress-pct');
      if (pctLabel) pctLabel.textContent = Math.round(pct) + '%';

      // Entries
      entriesList.innerHTML = '';
      emptyMsg.style.display = entries.length === 0 ? '' : 'none';

      // Badge
      if (entries.length > 0) {
        entriesBadge.textContent = entries.length;
        entriesBadge.classList.add('visible');
      } else {
        entriesBadge.classList.remove('visible');
      }

      var mealEmoji = { colazione: '\u2600\uFE0F', pranzo: '\uD83C\uDF5D', cena: '\uD83C\uDF19', spuntino: '\uD83C\uDF4E' };
      var mealLabels = { colazione: 'Colazione', pranzo: 'Pranzo', cena: 'Cena', spuntino: 'Spuntino' };

      entries.forEach(function (entry, i) {
        var el = document.createElement('div');
        el.className = 'entry-item';
        el.style.animationDelay = (i * 0.04) + 's';
        el.innerHTML =
          '<div class="entry-info">' +
            '<span class="entry-meal">' + (mealEmoji[entry.meal] || '') + ' ' + esc(mealLabels[entry.meal] || entry.meal) + '</span>' +
            '<span class="entry-desc">' + esc(entry.description) + '</span>' +
          '</div>' +
          '<div class="entry-right">' +
            '<span class="entry-kcal">' + entry.kcal + ' kcal</span>' +
            '<button class="entry-delete" data-id="' + esc(entry.id) + '">&times;</button>' +
          '</div>';
        entriesList.appendChild(el);
      });
    }

    function esc(s) {
      var d = document.createElement('div');
      d.appendChild(document.createTextNode(s));
      return d.innerHTML;
    }

    function loadState() { api('GET', '/api/state').then(render); }

    // ============================================================
    // ============================================================
    // Meal chips
    // ============================================================
    mealChipsContainer.addEventListener('click', function (e) {
      var chip = e.target.closest('.meal-chip');
      if (!chip) return;
      mealChipsContainer.querySelectorAll('.meal-chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      selectedMeal = chip.getAttribute('data-meal');
    });

    // ============================================================
    // Send button enable/disable
    // ============================================================
    chatInput.addEventListener('input', function () {
      chatSend.disabled = !chatInput.value.trim();
    });

    // ============================================================
    // Welcome screen
    // ============================================================
    function hideWelcome() {
      if (pepisWelcome) { pepisWelcome.remove(); pepisWelcome = null; }
    }

    // ============================================================
    // Safari mobile keyboard fix
    // ============================================================
    chatInput.addEventListener('focus', function () {
      setTimeout(function () {
        scrollChat();
        // Force Safari to recompute layout after keyboard opens
        window.scrollTo(0, 0);
      }, 300);
    });

    // Prevent iOS bounce when touching chat area
    chatMessages.addEventListener('touchmove', function (e) {
      e.stopPropagation();
    }, { passive: true });

    // Pepis Chat
    // ============================================================
    function scrollChat() { chatMessages.scrollTop = chatMessages.scrollHeight; }

    function addBubble(type, html) {
      var div = document.createElement('div');
      if (type === 'user') {
        div.className = 'chat-bubble user-bubble';
        div.innerHTML = '<div class="chat-bubble-content"><span class="chat-bubble-text">' + esc(html) + '</span></div>';
      } else {
        div.className = 'chat-bubble pepis-bubble';
        div.innerHTML =
          '<div class="pepis-bubble-avatar">&#127798;</div>' +
          '<div class="chat-bubble-content"><span class="chat-bubble-text">' + esc(html) + '</span></div>';
      }
      chatMessages.appendChild(div);
      scrollChat();
    }

    function addTyping() {
      var div = document.createElement('div');
      div.className = 'chat-bubble pepis-bubble';
      div.id = 'pepis-typing';
      div.innerHTML =
        '<div class="pepis-bubble-avatar">&#127798;</div>' +
        '<div class="chat-bubble-content typing-indicator">' +
          '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>' +
        '</div>';
      chatMessages.appendChild(div);
      scrollChat();
    }

    function removeTyping() {
      var el = document.getElementById('pepis-typing');
      if (el) el.remove();
    }

    function addCalorieCard(data, meal, text) {
      var div = document.createElement('div');
      div.className = 'chat-calorie-card';
      var rows = '';
      data.items.forEach(function (it) {
        rows +=
          '<div class="calorie-row">' +
            '<div class="calorie-row-left">' +
              '<span class="calorie-row-name">' + esc(it.name) + '</span>' +
              '<span class="calorie-row-qty">' + esc(it.quantity) + '</span>' +
            '</div>' +
            '<span class="calorie-row-kcal">' + it.calories + '</span>' +
          '</div>';
      });
      div.innerHTML =
        '<div class="calorie-card-items">' + rows + '</div>' +
        '<div class="calorie-card-total"><span>Totale</span><span class="calorie-total-value">' + data.totalCalories + ' kcal</span></div>' +
        '<button class="btn-add-meal">Aggiungi ai pasti</button>';
      chatMessages.appendChild(div);
      scrollChat();

      var btn = div.querySelector('.btn-add-meal');
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        btn.disabled = true; btn.textContent = 'Aggiungendo...';
        api('POST', '/api/entries', { meal: meal, description: text, kcal: data.totalCalories })
          .then(function (state) {
            if (state && state.error) { btn.disabled = false; btn.textContent = 'Aggiungi ai pasti'; return; }
            btn.textContent = 'Aggiunto!'; btn.classList.add('added');
            render(state);
            addBubble('pepis', 'Fatto! Registrato nei tuoi pasti di oggi \uD83D\uDCDD');
          })
          .catch(function () { btn.disabled = false; btn.textContent = 'Aggiungi ai pasti'; });
      });
    }

    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = chatInput.value.trim();
      if (!text || isWaiting) return;
      var meal = selectedMeal || 'pranzo';
      isWaiting = true; chatSend.disabled = true; chatInput.value = '';

      hideWelcome();
      addBubble('user', text);
      addTyping();

      api('POST', '/api/chat', { message: text })
        .then(function (data) {
          removeTyping(); isWaiting = false; chatSend.disabled = false;
          if (data && data.error) { addBubble('pepis', 'Uff, ho avuto un problema \uD83D\uDE35'); return; }
          if (data.message) addBubble('pepis', data.message);
          if (data.items && data.items.length > 0) addCalorieCard(data, meal, text);
        })
        .catch(function () {
          removeTyping(); isWaiting = false; chatSend.disabled = false;
          addBubble('pepis', 'Non riesco a rispondere, riprova tra poco \uD83D\uDE14');
        });
    });

    // ============================================================
    // Entries actions
    // ============================================================
    entriesList.addEventListener('click', function (e) {
      if (!e.target.classList.contains('entry-delete')) return;
      var id = e.target.getAttribute('data-id');
      if (!confirm('Eliminare questa voce?')) return;
      api('DELETE', '/api/entries/' + encodeURIComponent(id)).then(function (data) {
        if (data && !data.error) render(data);
      });
    });

    resetBtn.addEventListener('click', function () {
      if (!confirm('Cancellare tutti i pasti di oggi?')) return;
      api('POST', '/api/reset').then(function (data) {
        if (data && !data.error) render(data);
      });
    });

    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        fetch('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } })
          .then(function () { window.location.href = '/login'; });
      });
    }

    loadState();
  }
})();
