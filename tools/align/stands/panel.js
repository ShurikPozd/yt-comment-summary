// Стенд панели: только значки из разметки (data-icon), без логики панели.
import { hydrateIcons } from "/sidepanel/icons.js";
hydrateIcons();
// ?lists=1 — со списками каналов (скорость и громкость по каналам) на вымышленных данных
if (new URLSearchParams(location.search).has("lists")) await import("/tools/align/stands/panel-lists.js");
window.ok = 1;
