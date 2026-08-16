(function(){
  var SUN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>';
  var MOON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></svg>';

  function currentTheme(){
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function updateToggleButtons(theme){
    var icon = theme === 'light' ? SUN_ICON : MOON_ICON;
    var title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    document.querySelectorAll('[data-theme-toggle]').forEach(function(btn){
      var iconEl = btn.querySelector('.theme-toggle-icon');
      var labelEl = btn.querySelector('.theme-toggle-label');
      if(iconEl){
        iconEl.innerHTML = icon;
      }else{
        btn.innerHTML = icon;
      }
      if(labelEl){
        labelEl.textContent = theme === 'light' ? 'Light mode' : 'Dark mode';
      }
      btn.setAttribute('title', title);
      btn.setAttribute('aria-label', title);
    });
  }

  function setTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    try{ localStorage.setItem('fp_theme', theme); }catch(e){}
    updateToggleButtons(theme);
    document.dispatchEvent(new CustomEvent('fp-theme-change', { detail: { theme: theme } }));
  }

  function toggleTheme(){
    setTheme(currentTheme() === 'light' ? 'dark' : 'light');
  }

  document.addEventListener('DOMContentLoaded', function(){
    var theme = currentTheme();
    updateToggleButtons(theme);
    document.querySelectorAll('[data-theme-toggle]').forEach(function(btn){
      btn.addEventListener('click', toggleTheme);
    });
  });

  window.FPTheme = { set: setTheme, toggle: toggleTheme, get: currentTheme };
})();
