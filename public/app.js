// Service Worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  let csrfToken = '';

  fetch('/api/me')
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { window.location.href = '/login'; return; }
      csrfToken = data.csrfToken || '';
      initApp(data.user);
    })
    .catch(() => { window.location.href = '/login'; });

  function initApp(currentUser) {
    const goalValue      = $('#goal-value');
    const consumedValue  = $('#consumed-value');
    const remainingValue = $('#remaining-value');
    const cardRemaining  = $('#card-remaining');
    const progressBar    = $('#progress-bar');
    const ringFill       = $('#ring-fill');
    const entriesList    = $('#entries-list');
    const emptyMsg       = $('#empty-msg');

    // Meal di default in base all'ora
    const hour = new Date().getHours();
    let selectedMeal = hour >= 7 && hour < 11  ? 'colazione'
      : hour >= 11 && hour < 13 ? 'spuntino'
      : hour >= 13 && hour < 15 ? 'pranzo'
      : hour >= 15 && hour < 20 ? 'spuntino'
      : 'cena';

    const resetBtn         = $('#reset-btn');
    const logoutBtn        = $('#logout-btn');
    const userNameEl       = $('#user-name');
    const entriesBadge     = $('#entries-badge');
    const chatForm         = $('#chat-form');
    const chatInput        = $('#chat-input');
    const chatMessages     = $('#pepis-messages');
    const chatSend         = $('#chat-send');
    let   pepisWelcome     = $('#pepis-welcome');
    const mealChipsContainer = $('#meal-chips');
    const goalModal        = $('#goal-modal');
    const goalForm         = $('#goal-form');
    const goalInput        = $('#goal-input');
    const goalBtn          = $('#goal-btn');
    const goalCancel       = $('#goal-cancel');
    const confettiContainer = $('#confetti-container');
    const emptyCta         = $('#empty-cta-btn');

    let isWaiting = false;

    // ============================================================
    // User info
    // ============================================================
    const name = currentUser.displayName || currentUser.username;
    if (userNameEl) userNameEl.textContent = name;
    const avatarEl = $('#user-avatar');
    if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();

    // ============================================================
    // SVG Ring gradient
    // ============================================================
    const svgEl = document.querySelector('.ring-svg');
    if (svgEl) {
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
      grad.setAttribute('id', 'ring-gradient');
      grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
      grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '100%');
      const stops = [['0%', '#9b6dff'], ['50%', '#7c3aed'], ['100%', '#6366f1']];
      stops.forEach(([offset, color]) => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s.setAttribute('offset', offset); s.setAttribute('stop-color', color);
        grad.appendChild(s);
      });
      defs.appendChild(grad);
      svgEl.insertBefore(defs, svgEl.firstChild);
    }

    const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

    // ============================================================
    // Tab navigation (con slide orizzontale)
    // ============================================================
    const tabBtns   = $$('.tab-btn');
    const tabPanels = $$('.tab-panel');
    const tabOrder  = ['chat', 'entries']; // definisce la direzione della slide
    let currentTabIndex = 0;

    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab      = btn.getAttribute('data-tab');
        const newIndex = tabOrder.indexOf(tab);
        const oldIndex = currentTabIndex;
        if (newIndex === oldIndex) return;

        const goingRight = newIndex > oldIndex;
        const activePanel = document.querySelector('.tab-panel.active');
        const nextPanel   = document.getElementById(`panel-${tab}`);

        // Rimuovi animazioni residue
        tabPanels.forEach((p) => {
          p.classList.remove('slide-in-left','slide-in-right','slide-out-left','slide-out-right');
        });

        if (activePanel && nextPanel && activePanel !== nextPanel) {
          // Mostra entrambi durante l'animazione
          activePanel.style.display = 'flex';
          nextPanel.style.display   = 'flex';

          activePanel.classList.add(goingRight ? 'slide-out-left' : 'slide-out-right');
          nextPanel.classList.add(goingRight ? 'slide-in-right' : 'slide-in-left');

          const ANIM_DUR = 280;
          setTimeout(() => {
            activePanel.classList.remove('active', 'slide-out-left', 'slide-out-right');
            activePanel.style.display = '';
            nextPanel.classList.remove('slide-in-left', 'slide-in-right');
            nextPanel.classList.add('active');
          }, ANIM_DUR);
        } else if (nextPanel) {
          nextPanel.classList.add('active');
        }

        currentTabIndex = newIndex;
        tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    // Empty state CTA: torna al tab chat
    if (emptyCta) {
      emptyCta.addEventListener('click', () => {
        const chatBtn = document.querySelector('.tab-btn[data-tab="chat"]');
        if (chatBtn) chatBtn.click();
      });
    }

    // ============================================================
    // Goal modal
    // ============================================================
    goalBtn.addEventListener('click', () => {
      goalModal.classList.add('open');
      setTimeout(() => goalInput.focus(), 80);
    });
    goalCancel.addEventListener('click', () => goalModal.classList.remove('open'));
    goalModal.addEventListener('click', (e) => {
      if (e.target === goalModal) goalModal.classList.remove('open');
    });

    goalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = goalInput.value.trim();
      if (!val || isNaN(val) || Number(val) < 1) return;
      api('POST', '/api/goal', { goalKcal: Number(val) }).then((data) => {
        if (data && !data.error) {
          render(data);
          goalModal.classList.remove('open');
          goalInput.value = '';
        }
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
      const headers = { 'Content-Type': 'application/json' };
      if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
      const opts = { method, headers };
      if (body) opts.body = JSON.stringify(body);
      return fetch(apiPath, opts).then((r) => {
        if (r.status === 401) { window.location.href = '/login'; return Promise.reject(new Error('Auth')); }
        if (r.status === 403) {
          return r.json().then((d) => {
            if (d.error?.includes('CSRF')) {
              return fetch('/api/me').then((r2) => r2.json()).then((me) => {
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
    // Animate counter (smooth number roll)
    // ============================================================
    function animateValue(el, start, end, dur) {
      if (start === end) { el.textContent = end; return; }

      // Aggiungi classe shimmer al chip parent
      const chip = el.closest('.stat-chip');
      if (chip) {
        chip.classList.remove('updating');
        void chip.offsetWidth; // force reflow
        chip.classList.add('updating');
      }

      const range = end - start;
      let t0 = null;
      function step(ts) {
        if (!t0) t0 = ts;
        const p = Math.min((ts - t0) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
        el.textContent = Math.round(start + range * ease);
        if (p < 1) requestAnimationFrame(step);
        else {
          el.textContent = end;
          if (chip) chip.classList.remove('updating');
        }
      }
      requestAnimationFrame(step);
    }

    const prev = { goal: 0, consumed: 0, remaining: 0 };

    // ============================================================
    // Render state
    // ============================================================
    function render(state) {
      const { goalKcal: g, entries, totals: t } = state;

      animateValue(goalValue,      prev.goal,      g,           450);
      animateValue(consumedValue,  prev.consumed,  t.consumed,  450);
      animateValue(remainingValue, prev.remaining, t.remaining, 450);
      prev.goal = g; prev.consumed = t.consumed; prev.remaining = t.remaining;

      const exceeded = t.remaining < 0;
      cardRemaining.classList.toggle('exceeded', exceeded);
      if (progressBar) progressBar.classList.toggle('exceeded', exceeded);

      const pct = g > 0 ? Math.min((t.consumed / g) * 100, 100) : 0;
      if (progressBar) progressBar.style.width = pct + '%';
      if (ringFill) {
        ringFill.style.strokeDashoffset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
        ringFill.classList.toggle('exceeded', exceeded);
      }
      const pctLabel = document.getElementById('progress-pct');
      if (pctLabel) pctLabel.textContent = Math.round(pct) + '%';

      // ---- Entries ----
      entriesList.innerHTML = '';
      emptyMsg.style.display = entries.length === 0 ? '' : 'none';

      // Badge
      if (entries.length > 0) {
        entriesBadge.textContent = entries.length;
        entriesBadge.classList.add('visible');
      } else {
        entriesBadge.classList.remove('visible');
        entriesBadge.textContent = '';
      }

      const mealEmoji  = { colazione: '\u2600\uFE0F', pranzo: '\uD83C\uDF5D', cena: '\uD83C\uDF19', spuntino: '\uD83C\uDF4E' };
      const mealLabels = { colazione: 'Colazione', pranzo: 'Pranzo', cena: 'Cena', spuntino: 'Spuntino' };

      entries.forEach((entry, i) => {
        const el = document.createElement('div');
        el.className = 'entry-item';
        el.style.animationDelay = `${i * 0.045}s`;
        el.innerHTML =
          '<div class="entry-info">' +
            `<span class="entry-meal">${mealEmoji[entry.meal] || ''} ${esc(mealLabels[entry.meal] || entry.meal)}</span>` +
            `<span class="entry-desc">${esc(entry.description)}</span>` +
          '</div>' +
          '<div class="entry-right">' +
            `<span class="entry-kcal">${entry.kcal} kcal</span>` +
            `<button class="entry-delete" data-id="${esc(entry.id)}" aria-label="Elimina voce">&times;</button>` +
          '</div>';
        entriesList.appendChild(el);
      });
    }

    function esc(s) {
      const d = document.createElement('div');
      d.appendChild(document.createTextNode(s));
      return d.innerHTML;
    }

    function loadState() { api('GET', '/api/state').then(render); }

    // ============================================================
    // Persistenza chat lato server
    // ============================================================
    function loadChatHistory() {
      api('GET', '/api/chat/history').then((data) => {
        if (!data?.messages?.length) return;
        hideWelcome();
        data.messages.forEach((entry, idx) => {
          if (entry.type === 'user' || entry.type === 'pepis') {
            addBubble(entry.type, entry.text);
          } else if (entry.type === 'card') {
            const div = document.createElement('div');
            div.className = 'chat-calorie-card';
            div.dataset.chatIndex = idx;
            const rows = (entry.items || []).map((it) =>
              '<div class="calorie-row">' +
                '<div class="calorie-row-left">' +
                  `<span class="calorie-row-name">${esc(it.name)}</span>` +
                  `<span class="calorie-row-qty">${esc(it.quantity)}</span>` +
                '</div>' +
                `<span class="calorie-row-kcal">${it.calories}</span>` +
              '</div>'
            ).join('');
            div.innerHTML =
              `<div class="calorie-card-items">${rows}</div>` +
              `<div class="calorie-card-total">` +
                `<span>Totale</span>` +
                `<span class="calorie-total-value">${entry.totalCalories} kcal</span>` +
              `</div>` +
              (entry.added
                ? `<button class="btn-add-meal added" disabled>Aggiunto!</button>`
                : `<button class="btn-add-meal" disabled>Aggiungi ai pasti</button>`);
            chatMessages.appendChild(div);
          }
        });
        scrollChat();
      });
    }

    // ============================================================
    // Toast di successo
    // ============================================================
    function showSuccessToast(msg) {
      // Rimuovi eventuali toast precedenti
      const existing = document.querySelector('.success-toast');
      if (existing) existing.remove();

      const toast = document.createElement('div');
      toast.className = 'success-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke-dasharray:30">` +
          `<polyline points="20 6 9 17 4 12"/>` +
        `</svg>` +
        `<span>${msg}</span>`;
      document.body.appendChild(toast);

      // Rimuovi dopo l'animazione (2s show + 0.3s out)
      setTimeout(() => toast.remove(), 2600);
    }

    // ============================================================
    // Confetti
    // ============================================================
    function launchConfetti() {
      if (!confettiContainer) return;
      const colors = ['#9b6dff','#6366f1','#10e89e','#ff9f43','#ff6b6b','#fff'];
      const count  = 38;

      for (let i = 0; i < count; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        const x   = Math.random() * 100;
        const dur  = 1.2 + Math.random() * 1.1;
        const del  = Math.random() * 0.4;
        const rot  = Math.random() * 360;
        const size = 5 + Math.random() * 6;
        piece.style.cssText =
          `left:${x}%;` +
          `background:${colors[Math.floor(Math.random() * colors.length)]};` +
          `width:${size}px;height:${size}px;` +
          `border-radius:${Math.random() > 0.5 ? '50%' : '2px'};` +
          `transform:rotate(${rot}deg);` +
          `animation-duration:${dur}s;` +
          `animation-delay:${del}s;`;
        confettiContainer.appendChild(piece);
      }

      setTimeout(() => {
        confettiContainer.innerHTML = '';
      }, 2200);
    }

    // ============================================================
    // Meal chips
    // ============================================================
    const defaultChip = mealChipsContainer.querySelector(`[data-meal="${selectedMeal}"]`);
    if (defaultChip) defaultChip.classList.add('active');

    mealChipsContainer.addEventListener('click', (e) => {
      const chip = e.target.closest('.meal-chip');
      if (!chip) return;
      mealChipsContainer.querySelectorAll('.meal-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      selectedMeal = chip.getAttribute('data-meal');

      // Micro-feedback: rimbalzino
      chip.style.transform = 'scale(0.92)';
      setTimeout(() => { chip.style.transform = ''; }, 150);
    });

    // ============================================================
    // Send button enable/disable
    // ============================================================
    chatInput.addEventListener('input', () => {
      chatSend.disabled = !chatInput.value.trim();
    });

    // ============================================================
    // Welcome screen (con transizione fluida)
    // ============================================================
    function hideWelcome() {
      if (!pepisWelcome) return;
      pepisWelcome.classList.add('hiding');
      const el = pepisWelcome;
      pepisWelcome = null;
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
    }

    // ============================================================
    // iOS keyboard fix — scroll chat input into view
    // ============================================================
    chatInput.addEventListener('focus', () => {
      // Delay per aspettare che la tastiera iOS si apra
      setTimeout(() => {
        chatInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        scrollChat();
      }, 350);
    });

    // visualViewport resize: la tastiera cambia il viewport visibile
    if (window.visualViewport) {
      let prevHeight = window.visualViewport.height;
      window.visualViewport.addEventListener('resize', () => {
        const currentHeight = window.visualViewport.height;
        // Tastiera aperta (viewport si riduce)
        if (currentHeight < prevHeight && document.activeElement === chatInput) {
          setTimeout(() => {
            chatInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            scrollChat();
          }, 100);
        }
        prevHeight = currentHeight;
      });
    }

    chatMessages.addEventListener('touchmove', (e) => {
      e.stopPropagation();
    }, { passive: true });

    // ============================================================
    // Chat helpers
    // ============================================================
    function scrollChat() {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function addBubble(type, html) {
      const div = document.createElement('div');
      if (type === 'user') {
        div.className = 'chat-bubble user-bubble';
        div.innerHTML =
          `<div class="chat-bubble-content"><span class="chat-bubble-text">${esc(html)}</span></div>`;
      } else {
        div.className = 'chat-bubble pepis-bubble';
        div.innerHTML =
          '<div class="pepis-bubble-avatar">&#127798;</div>' +
          `<div class="chat-bubble-content"><span class="chat-bubble-text">${esc(html)}</span></div>`;
      }
      chatMessages.appendChild(div);
      scrollChat();
    }

    function addTyping() {
      const div = document.createElement('div');
      div.className  = 'chat-bubble pepis-bubble';
      div.id         = 'pepis-typing';

      // Avatar in modalita' thinking
      div.innerHTML =
        '<div class="pepis-bubble-avatar thinking">&#127798;</div>' +
        '<div class="chat-bubble-content typing-indicator">' +
          '<span class="typing-dot"></span>' +
          '<span class="typing-dot"></span>' +
          '<span class="typing-dot"></span>' +
        '</div>';
      chatMessages.appendChild(div);
      scrollChat();
    }

    function removeTyping() {
      const el = document.getElementById('pepis-typing');
      if (el) el.remove();
    }

    function addCalorieCard(data, meal, text) {
      const div = document.createElement('div');
      div.className = 'chat-calorie-card';

      const rows = data.items.map((it) =>
        '<div class="calorie-row">' +
          '<div class="calorie-row-left">' +
            `<span class="calorie-row-name">${esc(it.name)}</span>` +
            `<span class="calorie-row-qty">${esc(it.quantity)}</span>` +
          '</div>' +
          `<span class="calorie-row-kcal">${it.calories}</span>` +
        '</div>'
      ).join('');

      div.innerHTML =
        `<div class="calorie-card-items">${rows}</div>` +
        `<div class="calorie-card-total">` +
          `<span>Totale</span>` +
          `<span class="calorie-total-value">${data.totalCalories} kcal</span>` +
        `</div>` +
        `<button class="btn-add-meal">Aggiungi ai pasti</button>`;

      chatMessages.appendChild(div);
      scrollChat();

      const btn = div.querySelector('.btn-add-meal');

      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Aggiungendo...';

        api('POST', '/api/entries', { meal, description: text, kcal: data.totalCalories })
          .then((state) => {
            if (state?.error) {
              btn.disabled = false;
              btn.textContent = 'Aggiungi ai pasti';
              return;
            }
            // Successo
            btn.textContent = 'Aggiunto!';
            btn.classList.add('added');

            // Marca la card come aggiunta sul server
            const cardIdx = parseInt(div.dataset.chatIndex, 10);
            if (!isNaN(cardIdx)) api('POST', '/api/chat/mark-added', { index: cardIdx });

            // Animazioni di feedback
            launchConfetti();
            showSuccessToast('Pasto aggiunto!');

            render(state);
            addBubble('pepis', 'Fatto! Registrato nei tuoi pasti di oggi \uD83D\uDCDD');
          })
          .catch(() => {
            btn.disabled = false;
            btn.textContent = 'Aggiungi ai pasti';
          });
      });
    }

    // ============================================================
    // Submit chat
    // ============================================================
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text || isWaiting) return;

      const meal = selectedMeal || 'pranzo';
      isWaiting      = true;
      chatSend.disabled = true;
      chatInput.value   = '';
      chatSend.disabled = true;

      hideWelcome();
      addBubble('user', text);
      addTyping();

      api('POST', '/api/chat', { message: text })
        .then((data) => {
          removeTyping();
          isWaiting = false;
          chatSend.disabled = false;
          if (data?.error) { addBubble('pepis', `Uff, ho avuto un problema: ${data.error} \uD83D\uDE35`); return; }
          if (data.message) addBubble('pepis', data.message);
          if (data.items?.length > 0) addCalorieCard(data, meal, text);
        })
        .catch(() => {
          removeTyping();
          isWaiting = false;
          chatSend.disabled = false;
          addBubble('pepis', 'Non riesco a rispondere, riprova tra poco \uD83D\uDE14');
        });
    });

    // ============================================================
    // Entries actions
    // ============================================================
    entriesList.addEventListener('click', (e) => {
      if (!e.target.classList.contains('entry-delete')) return;
      const id = e.target.getAttribute('data-id');
      if (!confirm('Eliminare questa voce?')) return;
      api('DELETE', `/api/entries/${encodeURIComponent(id)}`).then((data) => {
        if (data && !data.error) render(data);
      });
    });

    resetBtn.addEventListener('click', () => {
      if (!confirm('Cancellare tutti i pasti di oggi?')) return;
      api('POST', '/api/reset').then((data) => {
        if (data && !data.error) render(data);
      });
    });

    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        fetch('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } })
          .then(() => { window.location.href = '/login'; });
      });
    }

    loadChatHistory();
    loadState();
  }
})();
