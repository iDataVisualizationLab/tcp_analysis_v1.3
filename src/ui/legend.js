// src/ui/legend.js
// Legend building and interaction

/**
 * Build legend UI with click handlers.
 * @param {HTMLElement} container - Legend container element
 * @param {string[]} items - Attack/group names
 * @param {Function} colorFn - Color lookup function
 * @param {Set} visibleAttacks - Set of currently visible attacks
 * @param {Object} callbacks - { onToggle, onIsolate, onUpdate }
 */
export function buildLegend(container, items, colorFn, visibleAttacks, callbacks) {
  container.innerHTML = '';
  const frag = document.createDocumentFragment();

  // Initialize all as visible if set is empty
  if (visibleAttacks.size === 0) {
    items.forEach(item => visibleAttacks.add(item));
  }

  items.forEach(p => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.style.cursor = 'pointer';
    item.style.userSelect = 'none';
    item.setAttribute('data-attack', p);

    const isVisible = visibleAttacks.has(p);
    if (!isVisible) {
      item.style.opacity = '0.3';
      item.style.textDecoration = 'line-through';
    }

    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = colorFn(p);
    const label = document.createElement('span');
    label.textContent = p;
    item.appendChild(sw);
    item.appendChild(label);

    // Click timing for distinguishing click vs dblclick
    let lastClickTime = 0;
    let clickTimeout = null;

    item.addEventListener('click', function(e) {
      const attackName = this.getAttribute('data-attack');
      const now = Date.now();

      if (now - lastClickTime < 300) {
        if (clickTimeout) { clearTimeout(clickTimeout); clickTimeout = null; }
        lastClickTime = now;
        return;
      }

      lastClickTime = now;
      if (clickTimeout) { clearTimeout(clickTimeout); }

      clickTimeout = setTimeout(() => {
        clickTimeout = null;
        callbacks.onToggle(attackName);
      }, 300);
    });

    item.addEventListener('dblclick', function(e) {
      e.preventDefault();
      if (clickTimeout) { clearTimeout(clickTimeout); clickTimeout = null; }
      const attackName = this.getAttribute('data-attack');
      callbacks.onIsolate(attackName);
      lastClickTime = Date.now();
    });

    item.addEventListener('mouseenter', function() {
      if (visibleAttacks.has(this.getAttribute('data-attack'))) {
        this.style.backgroundColor = 'rgba(0, 0, 0, 0.05)';
      }
    });
    item.addEventListener('mouseleave', function() {
      this.style.backgroundColor = '';
    });

    frag.appendChild(item);
  });
  container.appendChild(frag);
}

/**
 * Update legend visual state.
 */
export function updateLegendVisualState(container, visibleAttacks) {
  const items = container.querySelectorAll('.legend-item');
  items.forEach(item => {
    const attackName = item.getAttribute('data-attack');
    const isVisible = visibleAttacks.has(attackName);
    item.style.opacity = isVisible ? '1' : '0.3';
    item.style.textDecoration = isVisible ? 'none' : 'line-through';
  });
}

/**
 * Isolate single attack (or show all if already isolated).
 */
export function isolateAttack(attackName, visibleAttacks, container) {
  if (visibleAttacks.size === 1 && visibleAttacks.has(attackName)) {
    // Show all
    const items = container.querySelectorAll('.legend-item');
    visibleAttacks.clear();
    items.forEach(item => visibleAttacks.add(item.getAttribute('data-attack')));
  } else {
    // Isolate
    visibleAttacks.clear();
    visibleAttacks.add(attackName);
  }
}
