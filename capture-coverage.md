# Houston capture and exterior coverage

Greenway baseline: CoStar property 234298, Matterport model 39kv7R6xV7o.
The preview release contains the legacy room at `local-assets/room.json`
and its assets at `mesh-cache/39kv7R6xV7o/`.

| Property | CoStar ID | Matterport candidates |
| --- | --- | --- |
| Canal Street Flats | 9459693 | BZ5AMGkJP7s, mPdssaMi22b, n6SgFLzZohc, toNXWQLEzrZ |
| Emory at Canal | 9253786 | ULdLGCP2HTA |
| Headquarters | 10114277 | EHch9xT2MHK |
| 6525 Canal St | 10477610 | Kst1D1ZfDa8 |
| Twelve Greenway Plaza alternate room | 234298 | f54kk9QNpht |

These IDs were confirmed in the catalog. None has a local outline or textured
mesh in the preview bundle. Remote readability, boundary closure, and download
access are unverified from this checkout. Try a different Houston property first
if Canal Street still returns no closed outlines.

Use `capture_status.py --probe MODEL...` with authorized Matterport Model API
credentials in the process environment. A reported download link is a candidate,
with access confirmed only after the archive downloads and its assets validate.
Use `import_room.py MODEL --room ROOM` and `fetch_matterpak.py MODEL`.
Open the imported room using its model and room IDs, check the textured view and
save its alignment review in Scout. Record the verdict for a reproducible shot.
With default directories, hand off the matching
`local-assets/rooms/MODEL/ROOM.json`, `mesh-cache/MODEL/`, and
`local-assets/alignment/MODEL/room-ROOM.json` privately. Recheck alignment after
copying because the app verifies the mesh revision. For an open boundary, use
the measured import only with a scale-backed outline in the scan's axes.

## Vexcel

The preview database does not retain CoStar coordinates. Use longitude and
latitude from the original source record for property 234298. Optional block
bounds use west, south, east, north in WGS84 degrees.

```text
python3 exterior_coverage.py 234298 LONGITUDE LATITUDE --block WEST SOUTH EAST NORTH --plan
```

The plan prints the two Vexcel v2 coverage requests without credentials.
With a token entitled to oriented imagery and DSM, run the same request without
`--plan`. Coverage metadata alone does not establish that any raster was
retrieved. Record the selected image's capture date and the DSM's vertical units,
pixel size and raster CRS from the returned asset or its metadata, independently
of the WGS84 query CRS.

Unauthenticated requests to both collection endpoints returned HTTP 403.
Property coverage, façade imagery, capture date and DSM remain unverified.
Shadow obstruction remains unverified.

[Vexcel v2 documentation](https://api.vexcelgroup.com/v2/)


## Verified Canal Street capture

Canal Street Flats (CoStar `9459693`, model `BZ5AMGkJP7s`) was imported after the initial inventory check. The living room `613htqkzf66zz7hf7n8kzszed` rendered with textures and passed alignment review at 0 m. With a 24 mm lens and a 1.50 m lateral slide, the solver found roughly 46 cm of additional wall clearance, sampled framing, and clear sightlines at five sampled positions. Furniture clearance was unchecked. Greenway reached the eight-candidate sightline search limit for the same brief. The verified asset archive is available for private team transfer.

## Vexcel asset requests after coverage is confirmed

Use the collection’s layer and a verified oblique image name. Keep the token local.

| Evidence | Vexcel v2 operation | Parameters |
| --- | --- | --- |
| Capture date | `oriented/query` | `image-name=IMAGE`, `srid=4326`, `orientation=ALL`, `band=RGB`, `metadata-format=JSON`, `include=image-name,capture-date,collection,geometry,product-type` |
| Façade image | `oriented/extract` | `layer=LAYER`, `image-name=IMAGE`, `wkt=POINT(LON LAT)`, `srid=4326`, `downsample=2`, `attribution=true`, `image-format=jpeg` |
| Surface elevation | `dsm/tile` | `layer=LAYER`, `collection=COLLECTION`, `zoom=ZOOM`, `tile-x=X`, `tile-y=Y` for each tile covering the block |

Verify that the image shows the intended façade and retain its capture date. Record the DSM encoding, vertical units and datum, pixel size, and raster CRS from the returned data or provider metadata.

[Vexcel request examples](https://vexcel.atlassian.net/wiki/spaces/APIDOCS/pages/3035136040)
