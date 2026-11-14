# Scout foundation

Build the local catalog once using the extracted kit directory containing
commercial-properties.csv and data/commercial-property.jsonl.

    python3 catalog.py build "$HOME/Desktop/costar-hackathon/costar-hackathon-kit"
    python3 catalog.py search "Houston industrial showroom"

Search returns CoStar property IDs, source snippets, and linked Matterport
model IDs with captions when available. A result is a lead. Scanned-room
readiness must be established separately. Initial search uses weighted keyword
matching. A future agent can call the same search function as a tool.

For each shortlisted model, query room boundaries, scale, and asset availability
first. Import the MatterPak for selected rooms only. Cache files by model ID
and room geometry by model and room ID. Keep the catalog database, signed
URLs, private credentials, and imported scans local.

## Local search and room-plan preview

Run `python3 app.py` from this directory and open http://127.0.0.1:8001/.
On first launch the app indexes the kit. Use `--kit PATH` if the files are
elsewhere or `--db PATH` to use an existing catalog. Use `--assets PATH`
to point to a directory of existing room exports. The default is local-assets/ in this workspace. Use --assets ../hackprinceton-dljb
to open the legacy checkout. The server reads rooms/MODEL_ID/ROOM_ID.json,
rooms/MODEL_ID.json, and the legacy room.json. Search, select a linked scan, and choose Inspect room.
The viewer draws the imported metric outline and reports its bounding spans.

**Shortlist scan** saves the selected scan and opens it in the editor immediately.
With Matterport credentials on the server, it imports missing room outlines,
opens the first available room, and loads its cached or freshly downloaded
MatterPak. Use the room selector if the scan has several rooms.

## MatterPak workspace

With room assets available offline, Inspect room loads its textured MatterPak
alongside the captured floor plan and an interactive camera-path diagram.
Use Play slide or scrub through the move. Lens, sensor width, camera height, and travel are editable.
The 25 cm rig wall check covers the whole straight path conservatively.
Fit slide to room finds a shorter centered move that passes the wall check.
Furniture clearance and actor framing are outside this check.

The renderer uses the capture textures in sRGB with unlit materials, fixed
16:9 camera framing, and high-quality texture filtering. Lighting in the
texture comes from the scan. Asset requests are local. The Three.js renderer
and loaders use jsDelivr.

For the encrypted ZIP already in Downloads, you can build the index without
extracting the whole kit. The password prompt is private.

    python3 catalog.py build "$HOME/Downloads/costar-hackathon-kit.zip" --password-prompt

If the index cannot be built, the room workspace still starts. You can open
Greenway directly at http://127.0.0.1:8001/?model=39kv7R6xV7o.

If cloud storage leaves the existing MatterPak OBJ offline, recover the
already-unlocked bundle into this workspace without overwriting the original:

    python3 fetch_matterpak.py 39kv7R6xV7o

Or import an existing archive with `--zip PATH`. If the workspace is cloud-synced,
set `SCOUT_MESH_CACHE` to an offline directory before running either the importer
or the server. A ZIP with a missing referenced texture is rejected before it is cached. Enter API credentials only at the private prompts.

## Import rooms by model ID

Use the Matterport Model API to import selected models on demand:

    python3 import_room.py zvKHR9DHNjJ
    python3 import_room.py MODEL_ID --room ROOM_ID

The importer saves each closed outline under local-assets/rooms/MODEL_ID/ROOM_ID.json.
Use --assets PATH on both the importer and server for a different location.
It skips rooms with missing or unusable boundaries and preserves existing
exports. To work from saved GraphQL output, add `--response PATH`.
If the selected scan has multiple imported rooms, the room selector appears
in the editor. Shot edits and furniture marks are stored per room.
A missing height stays unknown in the data; the schematic viewer uses 3 m.
Download textures separately with fetch_matterpak.py for the selected model.

## Compare imported rooms

Open **Compare a shot across imported rooms**, enter a focal length and slide
distance, and compare the results. The comparison uses the same sensor width
and rig radius across rooms, with each room's own actor marks. Select
**Preview compared shot** to open a result in the editor. The initial comparison
checks room boundaries and sampled framing. Check furniture and captured
sightlines in the selected room before relying on a setup.

## Tool-calling scout

Set SCOUT_MODEL_URL to the provider's Chat Completions endpoint and
SCOUT_MODEL_NAME to a tool-capable model. Set SCOUT_MODEL_KEY if required.
Keep the key in the server environment. Start or restart app.py after configuring it.
The agent sends the shot brief and the CoStar and room evidence returned by its
tools to the configured provider. Use a provider permitted to receive that data.
Inside **Scout with a shot brief**, optionally lock the lens and choose whether
the agent can open a proposal. The activity list shows actual tool actions.
Agent proposals currently check walls and sampled framing. The editor separately
reports annotated furniture clearance and sampled mesh sightlines.

The editor and room comparison support static shots, lateral slides, and
push-ins. For an open shot the agent can test a follow-up revision in place,
using the editor's camera lock, actor and aim marks, furniture annotations,
and optional mesh sightline requirement. A tighter framing request searches
for a smaller sampled actor framing margin while keeping both stand-ins in
frame. Failed proposals leave the current shot in place.

Room selection is recorded in the workspace URL. Reloading restores the
same model and room along with its saved camera settings. Room comparison
and agent evaluations also account for furniture footprints previously
marked in that browser. Unmarked furniture and remote mesh sightlines
remain unverified during cross-room comparison.

Use **Place** on the floor plan to reposition the camera or a staged actor.
Actor edits re-center camera aim and persist per room. The comparison uses
the saved marks and includes them when opening the proposed shot. Use
**Lock current room** to limit agent application to in-place revisions.

## Save a scouting project

Use **Projects → Save project** to store a named project in this browser.
It includes the search query, brief and agent locks, selected room, shot
settings, furniture marks, and up to 20 applied agent revisions with their
tool activity. **Open project** restores the saved settings and runs the
saved search again. Reloading its workspace URL restores the saved snapshot. Use **Open revision** to revisit an earlier agent setup.
Saving is explicit. Projects reference local room and mesh assets, so those
assets must still be available when reopening. **Export project** downloads the
selected saved snapshot as JSON. **Import project** opens a copy with its own
project ID. The transfer file includes the brief and agent activity, so review
it before sharing.

Choose **Camera start** or **Camera end** under **Place**, then click a
point on the plan. The editor preserves the other endpoint and checks the
resulting custom path. Paths up to 4 m can be saved with the project and
exported with their measured start and end marks.

CoStar search also supports exact city and property-type filters. Combine
them with optional keywords. Property-type filters require the full property
export because the starter CSV contains addresses and scan IDs.

For cross-room comparisons, **Require captured sightlines** checks five
camera positions against the MatterPak mesh before proposing a setup. It
requires a room record with matterpakAlignmentVerified set to true after
checking model alignment. Greenway uses a checked preset. Missing geometry
or alignment is reported as unknown. The cross-room search bounds expensive
mesh checks to eight candidates per room.

On macOS, save the Matterport credentials as password items named
`scout-matterport-key` and `scout-matterport-token` in your login Keychain.
Set the account on both items to your macOS username. The app reads them
automatically at startup. You may be prompted for Keychain access on first use.
For other setups or to override Keychain, set `MATTERPORT_API_KEY` and
`MATTERPORT_API_TOKEN` in the server environment. Opening a linked scan fetches missing room outlines and then
downloads its MatterPak on demand. The server caches the validated archive
contents by model ID, so reopening the scan or switching rooms reuses the same
assets. The editor shows the scaled outline while the bundle downloads and
keeps the current shot when it switches to the captured mesh.

The server needs access to an existing MatterPak ZIP for that scan. If
Matterport does not expose one, the editor keeps the outline and offers ZIP
upload. The editor still needs an alignment review for a new mesh before
using it for captured sightline checks.

In the scout, enable **Allow the agent to fetch room outlines and MatterPaks**
and the option to apply its recommendation. The agent can import outlines
for promising CoStar leads, evaluate shot setups, and prepare the captured
scene for its recommendation. If the preferred capture fails, it tries the
next qualifying scan. Each investigation can request up to two uncached
MatterPaks. Properties with no linked scan or no accessible bundle remain
leads for follow-up.

For an imported MatterPak, **Inspect mesh alignment** overlays the metric
outline on an overhead mesh view. Adjust floor elevation and save the
review before relying on sampled sightline checks. Reviews are stored
locally per room under the selected assets directory's alignment folder.
Changing the underlying OBJ invalidates a saved review.

Rooms without provisional blocking can be staged manually. Place either actor
first using the floor-plan selector. Partially staged rooms retain their marks
and remain unevaluated for two-shot framing until both actors are placed.

Saved shot JSON includes the playback duration and smoothstep interpolation
rule. It reports the actor index, path fraction, and playback time
when the aligned MatterPak detects an obstruction at a sampled position.

### Import a measured room when the API boundary is open

Select a linked scan and open **Import measured room outline** to upload a
plan. From the terminal, run
`python3 import_room.py MODEL_ID --room ROOM_ID --measured outline.json`.
The JSON file needs `units: "meters"`, `source` describing the measurement,
and `outline` containing boundary-ordered `[x, z]` pairs in the scan's axes.
Optional `label` and `height` are supported. Use points measured from the
actual room or a scaled plan. Place actor marks in the editor and review the
alignment against the MatterPak before running scan sightline checks.

## Direct sunlight study

Open an aligned MatterPak room and expand **Direct sunlight**. Enter verified
site coordinates, the IANA time zone and the true bearing of the room's +z
axis. Pick four perimeter corners per window on the scan or enter measured
corners in the window fields. Review the outward normal before saving. The
date and time controls display a separate direct-sun overlay over photographed
textures and report exposure at each actor's eye-height mark. The result
assumes unobstructed exterior sun where no usable elevation data is available.

An optional normalized Vexcel DSM can be placed alongside the daylight profile
as `legacy-daylight-dsm.json` or `room-ROOM_ID-daylight-dsm.json`. Use
`crs: "EPSG:4326"`, `units: "meters"`, a verified `datum`, `bounds` in
west/south/east/north order, and north-to-south rows of pixel elevations in
`heights`. Use null for missing cells. Each window needs a verified
`exterior` center with longitude, latitude, elevationMeters, and matching
datum. The estimate checks a center ray from 2 to 150 m outside the window.
An obstruction beyond that distance is outside the study coverage.

Run daylight backend tests with
`python3 -m unittest discover -s tests -p test_daylight.py` and geometry checks
with `node tests/check-daylight-geometry.mjs THREE_PACKAGE_DIR`.

The server fills site latitude, longitude, and the known Houston or Los Angeles
time zone from the linked CoStar property. For a portable database without
coordinates, point the app at the extracted kit or run
`python3 catalog.py index-coordinates KIT_PATH` (add `--password-prompt` for
an encrypted kit). Use `python3 catalog.py scan-location MODEL_ID` to retrieve
the same property ID and coordinates for the Vexcel coverage tooling. Site
coordinates can seed a Vexcel query. The window's measured position, elevation,
and true-north alignment remain independent of the property's geocode.
