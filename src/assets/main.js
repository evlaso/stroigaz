// Keep demonstration links interactive without navigating to a fake destination.
document.addEventListener('click', (event) => {
  if (event.target.closest('a[data-placeholder-link]')) {
    event.preventDefault();
  }
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
