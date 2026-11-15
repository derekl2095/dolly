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
let total = 0;
let failed = false;
let lookup = new AbortController();
let pending = 0;
let selectedProperty;

function selectProperty(id, card) {
  const previous = locations.get(selectedProperty);
  previous?.card.classList.remove("map-selected");
  previous?.marker.getElement()?.classList.remove("map-selected");
  previous?.marker.setZIndexOffset(0);
  selectedProperty = id;
  card.classList.add("map-selected");
  const marker = locations.get(id)?.marker;
  marker?.getElement()?.classList.add("map-selected");
  marker?.setZIndexOffset(500);
}

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

function showCity() {
  if (!pins) return;
  const city = cityKey(cityPicker.value);
  map.closePopup();
  pins.clearLayers();
  for (const location of locations.values()) {
    if (!city || location.city === city) location.marker.addTo(pins);
  }
  const selected = locations.get(selectedProperty);
  if (selected) selected.marker.getElement()?.classList.add("map-selected");
  updateStatus();
  fit();
}

function updateStatus() {
  if (pending) {
    status.textContent = "Finding property addresses…";
    return;
  }
  const count = pins.getLayers().length;
  status.textContent = cityPicker.value
    ? `${count} of ${total} loaded properties mapped in ${cityPicker.value}`
    : count ? `${count} of ${total} loaded properties mapped`
    : failed ? "Address lookup is temporarily unavailable." : "No matching addresses could be mapped.";
}

cityPicker.addEventListener("change", showCity);

export function resetLocationMap(city = "") {
  generation++;
  lookup.abort();
  lookup = new AbortController();
  total = 0;
  pending = 0;
  failed = false;
  selectedProperty = undefined;
  locations.clear();
  cityPicker.selectedIndex = Math.max(0, [...cityPicker.options].findIndex(option => cityKey(option.value) === cityKey(city)));
  pins?.clearLayers();
  panel.hidden = true;
}

export async function addMapLocations(rows, cards) {
  const current = generation;
  const {signal} = lookup;
  total += rows.length;
  pending++;
  panel.hidden = surface.hidden = false;
  status.textContent = "Finding property addresses…";
  try {
    const L = await loadLibrary();
    if (current !== generation || signal.aborted) return;
    fit();
    let index = 0;
    const locateNext = async () => {
      while (index < rows.length && !signal.aborted && current === generation) {
        const item = index++;
        const row = rows[item];
        try {
          const response = await fetch("/api/location-map?property=" + encodeURIComponent(row.property_id), {signal});
          if (!response.ok) throw Error("Could not look up address.");
          const {position} = await response.json();
          if (!position || signal.aborted || current !== generation) continue;
          const label = row.name || row.street;
          const popup = document.createElement("div");
          const title = document.createElement("strong");
          title.textContent = label;
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Show property";
          button.addEventListener("click", () => {
            map.closePopup();
            selectProperty(row.property_id, cards[item]);
            cards[item].focus();
          });
          const source = document.createElement("small");
          source.textContent = position.approximate ? "Approximate street address" : "CoStar property coordinates";
          popup.append(title, source, button);
          const marker = L.marker([position.latitude, position.longitude], {
            title: label, alt: label,
            icon: L.divIcon({className: "scout-map-pin", iconSize: [16, 16], iconAnchor: [8, 8]}),
          }).bindPopup(popup);
          marker.on("click", () => selectProperty(row.property_id, cards[item]));
          const city = cityKey(row.city);
          locations.set(row.property_id, {city, marker, card: cards[item]});
          if (!cityPicker.value || cityKey(cityPicker.value) === city) marker.addTo(pins);
        } catch {
          if (!signal.aborted && current === generation) failed = true;
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(3, rows.length)}, locateNext));
    if (current !== generation || signal.aborted) return;
    if (--pending) return;
    showCity();
  } catch {
    if (current !== generation || signal.aborted) return;
    status.textContent = "Map unavailable. Property results are still available.";
    surface.hidden = true;
  }
}
