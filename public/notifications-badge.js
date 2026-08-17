(function(){
  async function refreshBadge(){
    const badge = document.getElementById('notifBadge');
    if(!badge) return;
    try{
      const res = await fetch('/api/notifications');
      if(!res.ok) return;
      const { alerts } = await res.json();
      const count = (alerts || []).length;
      if(count > 0){
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = 'inline-flex';
      }else{
        badge.style.display = 'none';
      }
    }catch(e){ /* not critical — badge just stays as-is */ }
  }
  window.FPNotif = { refreshBadge: refreshBadge };
})();
