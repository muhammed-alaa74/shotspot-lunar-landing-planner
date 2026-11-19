/** Smooth-scroll to a section of the planner page (ids: sites, mission, landing, compare). */
export function goSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(null, '', `${location.pathname}#${id}`);
}
