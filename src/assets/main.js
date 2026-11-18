// Keep demonstration links interactive without navigating to a fake destination.
document.addEventListener('click', (event) => {
  if (event.target.closest('a[data-placeholder-link]')) {
    event.preventDefault();
  }
});

// Progressive enhancement: without this setup, the ordinary header stays visible.
const menuToggle = document.querySelector('.menu-toggle');
const mobileMenu = document.querySelector('#mobile-menu');

if (menuToggle && mobileMenu) {
  const menuClose = mobileMenu.querySelector('.menu-close');
  const desktop = window.matchMedia('(min-width: 1100px)');
  const background = [...document.body.children].filter((element) => element !== mobileMenu);
  const previousInert = new Map();

  function closeMenu() {
    if (mobileMenu.hidden) return;
    mobileMenu.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('menu-open');
    previousInert.forEach((inert, element) => { element.inert = inert; });
    previousInert.clear();
    // The burger is hidden on desktop, so return focus to the regular navigation.
    const target = desktop.matches ? document.querySelector('header nav a') : menuToggle;
    target?.focus({ preventScroll: true });
  }

  function openMenu() {
    if (desktop.matches || !mobileMenu.hidden) return;
    mobileMenu.hidden = false;
    mobileMenu.scrollTop = 0;
    menuToggle.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('menu-open');
    background.forEach((element) => {
      previousInert.set(element, element.inert);
      element.inert = true;
    });
    menuClose.focus({ preventScroll: true });
  }

  menuToggle.addEventListener('click', openMenu);
  menuClose.addEventListener('click', closeMenu);
  mobileMenu.addEventListener('click', (event) => {
    if (event.target.closest('a[href]')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (mobileMenu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    } else if (event.key === 'Tab') {
      const focusable = [...mobileMenu.querySelectorAll('button, a[href], [tabindex="0"]')]
        .filter((element) => !element.disabled && element.getClientRects().length);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !mobileMenu.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !mobileMenu.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  desktop.addEventListener('change', () => {
    if (desktop.matches) closeMenu();
  });
  menuToggle.hidden = false;
  document.documentElement.classList.add('menu-ready');
}

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

// Both audiences are rendered statically; only replace the audience control elements.
document.querySelectorAll('[data-project-audiences]').forEach((browser) => {
  const control = browser.querySelector('.project-audience-switch');
  const segments = [...control.querySelectorAll('.project-audience-segment[data-audience]')]
    .map((element) => ({ element, url: element.dataset.url }));
  const views = [...browser.querySelectorAll('[data-audience-view]')];

  // Keep route URLs independently of whether a segment is currently a link or a span.
  const routePath = (url) => new URL(url, location.href).pathname.replace(/\/?$/, '/');

  function update(url = location.href) {
    const path = routePath(url);
    const current = segments.find((segment) => routePath(segment.url) === path);
    if (!current) return;

    segments.forEach((segment) => {
      const active = segment === current;
      const tag = active ? 'SPAN' : 'A';
      if (segment.element.tagName !== tag) {
        const replacement = document.createElement(tag.toLowerCase());
        [...segment.element.attributes].forEach(({ name, value }) => {
          if (name !== 'href' && name !== 'aria-current') replacement.setAttribute(name, value);
        });
        replacement.textContent = segment.element.textContent;
        segment.element.replaceWith(replacement);
        segment.element = replacement;
      }
      if (active) {
        segment.element.removeAttribute('href');
        segment.element.setAttribute('aria-current', 'page');
      } else {
        segment.element.setAttribute('href', segment.url);
        segment.element.removeAttribute('aria-current');
      }
    });
    const { dataset } = current.element;
    views.forEach((view) => {
      view.hidden = view.dataset.audienceView !== dataset.audience;
    });
    document.title = dataset.title;
    document.querySelector('link[rel="canonical"]').href = dataset.canonical;
    document.querySelector('meta[property="og:url"]').content = dataset.canonical;
    ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']
      .forEach((selector) => { document.querySelector(selector).content = dataset.description; });
    ['meta[property="og:title"]', 'meta[name="twitter:title"]']
      .forEach((selector) => { document.querySelector(selector).content = dataset.title; });
  }

  control.addEventListener('click', (event) => {
    const link = event.target.closest('a.project-audience-segment[data-audience]');
    if (!link || !control.contains(link)) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (location.href !== link.href) history.pushState(null, '', link.href);
    update();
  });
  window.addEventListener('popstate', () => { update(); });
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
    diagram.style.setProperty('--diagram-radius', `${Math.min(540, Math.max(280, bounds.width * 0.75))}px`);
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
