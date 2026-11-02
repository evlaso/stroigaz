// Keep demonstration links interactive without navigating to a fake destination.
document.addEventListener('click', (event) => {
  if (event.target.closest('a[data-placeholder-link]')) {
    event.preventDefault();
  }
});

document.querySelectorAll('.project-media').forEach((media) => {
  const photo = media.querySelector('.project-photo');
  if (!photo) return;

  async function reveal() {
    if (!photo.naturalWidth) return;
    try {
      await photo.decode();
    } catch {
      // A successfully loaded image can still be displayed if decoding rejects.
    }
    if (photo.naturalWidth) media.classList.add('is-loaded');
  }

  photo.addEventListener('load', reveal, { once: true });
  if (photo.complete) reveal();
});

document.querySelectorAll('[data-project-browser]').forEach((browser) => {
  const filters = browser.querySelector('.project-filters');
  const buttons = [...browser.querySelectorAll('[data-industry-filter]')];
  const cards = [...browser.querySelectorAll('[data-industry]')];
  const status = browser.querySelector('[data-filter-status]');
  let selected = '';

  function update() {
    let visible = 0;
    cards.forEach((card) => {
      card.hidden = selected !== '' && selected !== card.dataset.industry;
      if (!card.hidden) visible += 1;
    });
    buttons.forEach((button) => {
      button.setAttribute('aria-pressed', String(selected === button.dataset.industryFilter));
    });
    status.textContent = `Показано проектов: ${visible} из ${cards.length}`;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      selected = button.dataset.industryFilter;
      update();
    });
  });
  update();
  filters.hidden = false;
});

// Reveal lit metal locally, keeping the two versions perfectly registered.
document.querySelectorAll('.diagram-variant:not([data-linked-reveal])').forEach((diagram) => {
  let frame = 0;
  let point = null;

  function paint() {
    frame = 0;
    if (!point) return;
    const bounds = diagram.getBoundingClientRect();
    diagram.style.setProperty('--diagram-x', `${point.x - bounds.left}px`);
    diagram.style.setProperty('--diagram-y', `${point.y - bounds.top}px`);
    diagram.style.setProperty('--diagram-radius', `${Math.min(270, Math.max(150, bounds.width * 0.4))}px`);
    diagram.classList.add('is-revealing');
  }

  function move(event) {
    if (event.pointerType === 'touch') return;
    point = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function clear() {
    point = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    diagram.classList.remove('is-revealing');
  }

  diagram.addEventListener('pointerenter', move);
  diagram.addEventListener('pointermove', move);
  diagram.addEventListener('pointerleave', clear);
  diagram.addEventListener('pointercancel', clear);
  diagram.addEventListener('focus', () => {
    if (!diagram.matches(':focus-visible')) return;
    const bounds = diagram.getBoundingClientRect();
    point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    paint();
  });
  diagram.addEventListener('blur', clear);
});
