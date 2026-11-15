const panel = document.querySelector("#location-map-panel");
const status = document.querySelector("#location-map-status");
const surface = document.querySelector("#location-map");
const cityPicker = document.querySelector("#location-map-city");
const cityViews = new Map([["houston", [29.7604, -95.3698]], ["los angeles", [34.0522, -118.2437]]]);
const locations = new Map();
const cityKey = city => (city || "").trim().toLowerCase();
const cdn = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist";
let loading;
let map;
let pins;
let generation = 0;
let lookup = new AbortController();

function loadLibrary() {
  if (loading) return loading;
  loading = Promise.all([["link", css => {
    css.rel = "stylesheet";
    css.href = cdn + "/leaflet.css";
  }], ["script", script => { script.src = cdn + "/leaflet.js"; }]].map(([tag, prepare]) =>
    new Promise((resolve, reject) => {
      const resource = document.createElement(tag);
      resource.onload = resolve;
      resource.onerror = reject;
      prepare(resource);
      document.head.append(resource);
    }))).then(() => {
    const L = window.L;
    map = L.map(surface, {scrollWheelZoom: false, fadeAnimation: false});
    map.setView([39, -98], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    pins = L.featureGroup().addTo(map);
    new ResizeObserver(fit).observe(surface);
    return L;
  });
  return loading;
}

function fit() {
  if (!map || !surface.clientWidth) return;
  map.invalidateSize({pan: false});
  const city = cityKey(cityPicker.value);
  const bounds = window.L.latLngBounds([...locations.values()]
    .filter(location => !city || location.city === city)
    .map(location => location.marker.getLatLng()));
  if (bounds.isValid()) map.fitBounds(bounds, {padding: [32, 32], maxZoom: 14, animate: false});
  else map.setView(cityViews.get(city) || [39, -98], city ? 11 : 4, {animate: false});
}

export function resetLocationMap(city = "") {
  generation++;
  lookup.abort();
  lookup = new AbortController();
  locations.clear();
  cityPicker.selectedIndex = Math.max(0, [...cityPicker.options].findIndex(option => cityKey(option.value) === cityKey(city)));
  pins?.clearLayers();
  panel.hidden = true;
}

export async function loadLocationMap(filters, openProperty) {
  const current = generation;
  const {signal} = lookup;
  const query = new URLSearchParams(filters);
  query.set("map", "1");
  panel.hidden = surface.hidden = false;
  status.textContent = "Loading all matching locations…";
  try {
    const [L, response] = await Promise.all([loadLibrary(), fetch("/api/locations?" + query, {signal})]);
    if (!response.ok) throw Error("Map request failed.");
    const {rows} = await response.json();
    if (current !== generation || signal.aborted) return;
    for (const row of rows) {
      if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) continue;
      const label = row.name || row.street;
      const popup = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = label;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Show property";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await openProperty(row.property_id, signal);
          map.closePopup();
        } catch {
          if (!signal.aborted) button.textContent = "Retry property";
        } finally {
          button.disabled = false;
        }
      });
      popup.append(title, button);
      const marker = L.marker([row.latitude, row.longitude], {
        title: label, alt: label,
        icon: L.divIcon({className: "scout-map-pin", iconSize: [16, 16], iconAnchor: [8, 8]}),
      }).bindPopup(popup).addTo(pins);
      locations.set(row.property_id, {city: cityKey(row.city), marker});
    }
    status.textContent = `${locations.size} of ${rows.length} matching properties mapped`;
    fit();
  } catch {
    if (current !== generation || signal.aborted) return;
    status.textContent = "Map unavailable. Property results are still available.";
    surface.hidden = true;
  }
}
