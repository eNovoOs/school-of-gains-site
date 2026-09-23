// Keep the supplied artwork after the mirrored site's runtime hydrates.
(() => {
  function updateBrand() {
    document.querySelectorAll('.nav-logo, .footer-logo, .nav .brand').forEach(brand => {
      if (brand.querySelector('.sog-logo')?.getAttribute('src') === '/assets/sog-logo-horizontal.png') return;
      if (!brand.querySelector('img')) return;
      const image = document.createElement('img');
      image.className = 'sog-logo';
      image.src = '/assets/sog-logo-horizontal.png';
      image.alt = 'School of Gains — Presented by PaperGains';
      brand.classList.add('sog-brand');
      brand.replaceChildren(image);
    });
  }
  updateBrand();
  new MutationObserver(updateBrand).observe(document.documentElement, {childList:true,subtree:true});
})();
