(function(){
  var SUN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>';
  var MOON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></svg>';

  // The stored preference is one of 'light' | 'dark' | 'system'. 'system'
  // means "follow the OS setting" and isn't a theme by itself — it has to
  // be resolved to an actual light/dark value before it can be applied.
  function storedMode(){
    var m;
    try{ m = localStorage.getItem('fp_theme'); }catch(e){ m = null; }
    return (m === 'light' || m === 'dark' || m === 'system') ? m : 'system';
  }

  function systemPrefersDark(){
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function resolveTheme(mode){
    if(mode === 'light' || mode === 'dark') return mode;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  // The currently *applied* theme (always a concrete light/dark value,
  // never 'system') — distinct from storedMode(), which is the preference.
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

  function updateModeButtons(mode){
    document.querySelectorAll('[data-theme-mode]').forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-theme-mode') === mode);
    });
  }

  function applyResolvedTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    updateToggleButtons(theme);
    document.dispatchEvent(new CustomEvent('fp-theme-change', { detail: { theme: theme } }));
  }

  // Sets the stored preference — 'light', 'dark', or 'system' — and applies
  // whatever that resolves to right away.
  function setMode(mode){
    if(mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    try{ localStorage.setItem('fp_theme', mode); }catch(e){}
    applyResolvedTheme(resolveTheme(mode));
    updateModeButtons(mode);
  }

  function getMode(){
    return storedMode();
  }

  // Kept for compatibility with any old call sites: sets an explicit
  // light/dark override (never 'system').
  function setTheme(theme){
    setMode(theme === 'light' ? 'light' : 'dark');
  }

  // The quick sidebar toggle — flips between light/dark as an explicit
  // override, stepping out of 'system' mode if that was active.
  function toggleTheme(){
    setMode(currentTheme() === 'light' ? 'dark' : 'light');
  }

  document.addEventListener('DOMContentLoaded', function(){
    updateToggleButtons(currentTheme());
    updateModeButtons(storedMode());
    document.querySelectorAll('[data-theme-toggle]').forEach(function(btn){
      btn.addEventListener('click', toggleTheme);
    });
    document.querySelectorAll('[data-theme-mode]').forEach(function(btn){
      btn.addEventListener('click', function(){
        setMode(btn.getAttribute('data-theme-mode'));
      });
    });
  });

  // Live-follow the OS setting while in 'system' mode — e.g. macOS
  // switching to dark at sunset, without needing a page reload.
  if(window.matchMedia){
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onSystemChange = function(){
      if(storedMode() === 'system') applyResolvedTheme(resolveTheme('system'));
    };
    if(mq.addEventListener) mq.addEventListener('change', onSystemChange);
    else if(mq.addListener) mq.addListener(onSystemChange); // older Safari
  }

  window.FPTheme = { set: setTheme, setMode: setMode, getMode: getMode, toggle: toggleTheme, get: currentTheme };
})();
