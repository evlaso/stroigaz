// Keep demonstration links interactive without navigating to a fake destination.
document.addEventListener('click', (event) => {
  if (event.target.closest('a[data-placeholder-link]')) {
    event.preventDefault();
  }
});
