/*
Project: Samruddhi Expressway Progress Analysis
Author: Rohit Kumar Jangid

Description:
This script performs corridor segmentation, satellite analysis,
index computation (NDVI, BSI, NDBI), and construction stage classification
using Google Earth Engine.
*/




/********** CORRIDOR ANALYSIS **********/

var corridor = ee.Geometry.LineString(geometry.coordinates());
Map.addLayer(corridor, {color: 'blue'}, 'Corridor');
Map.centerObject(corridor, 9);


/********** SEGMENTATION **********/

var segmentLength = 3000; // 3 km

var line = ee.Feature(corridor);

var segments = ee.FeatureCollection(
  line.cutLines(ee.List.sequence(0, corridor.length(), segmentLength))
);

segments = segments.map(function(f) {
  return f.set('Segment_ID', ee.Number.parse(f.id()));
});


var buffer = corridor.buffer(200);

Map.addLayer(buffer, {color: 'green'}, 'Buffer');
Map.addLayer(segments, {color: 'red'}, 'Segments');


/********** CLOUD MASK **********/

function maskClouds(image) {
  var scl = image.select('SCL');

  var mask = scl.eq(4)
    .or(scl.eq(5))
    .or(scl.eq(6))
    .or(scl.eq(7));

  return image.updateMask(mask);
}


/********** SENTINEL COLLECTION **********/

var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(corridor);


/********** TIME SERIES **********/

function getComposite(start, end) {
  return s2
    .filterDate(start, end)
    .map(maskClouds)
    .median()
    .clip(buffer);
}

var img_2024_early = getComposite('2024-01-01','2024-02-01');
var img_2024_mid   = getComposite('2024-06-01','2024-07-01');
var img_2025_early = getComposite('2025-01-01','2025-02-01');
var img_2025_mid   = getComposite('2025-05-01','2025-06-01');

// Visual comparison
Map.addLayer(img_2024_early, {bands:['B4','B3','B2'], min:0, max:3000}, '2024 Early');
Map.addLayer(img_2025_mid, {bands:['B4','B3','B2'], min:0, max:3000}, '2025 Mid');


/*************** NDVI, BSI, NDBI ************/

var ndvi_vis = img_2025_mid.normalizedDifference(['B8','B4']);
Map.addLayer(ndvi_vis, {
  
  min: 0.1,
  max: 0.7,

  palette: ['darkred','orange','yellow','lightgreen','darkgreen']

}, 'NDVI');

var bsi_vis = img_2025_mid.expression(
  '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))',
  {
    'SWIR': img_2025_mid.select('B11'),
    'RED': img_2025_mid.select('B4'),
    'NIR': img_2025_mid.select('B8'),
    'BLUE': img_2025_mid.select('B2')
  }
);
Map.addLayer(bsi_vis, {
  
  min: 0,
  max: 0.8,
  palette: ['blue','white','brown']
}, 'BSI');

var ndbi_vis = img_2025_mid.normalizedDifference(['B11','B8']);
Map.addLayer(ndbi_vis, {
  min: -1,
  max: 1,
  palette: ['black','white','orange']
}, 'NDBI');


/********** INDEX FUNCTION **********/

function addIndices(image) {

  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');

  var bsi = image.expression(
    '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))',
    {
      'SWIR': image.select('B11'),
      'RED': image.select('B4'),
      'NIR': image.select('B8'),
      'BLUE': image.select('B2')
    }
  ).rename('BSI');

  var ndbi = image.normalizedDifference(['B11', 'B8']).rename('NDBI');

  return image.addBands([ndvi, bsi, ndbi]);
}


/********** CLASSIFICATION **********/

function classifySegments(image, label) {

  var img = addIndices(image);

  var segmentStats = segments.map(function(seg) {

    var stats = img.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: seg.geometry(),
      scale: 30,
      maxPixels: 1e9
    });

    var ndvi = ee.Number(stats.get('NDVI'));
    var bsi  = ee.Number(stats.get('BSI'));
    var ndbi = ee.Number(stats.get('NDBI'));

    var status = ee.Algorithms.If(
      ndvi.gt(0.4), 'Not Started',
      ee.Algorithms.If(
        bsi.gt(0.15), 'Under Construction',
        ee.Algorithms.If(
          ndbi.gt(0.1), 'Completed',
          'Under Construction'
        )
      )
    );

    return seg.set({
      'NDVI': ndvi,
      'BSI': bsi,
      'NDBI': ndbi,
      'Status': status,
      'Time': label
    });
  });

  return segmentStats;
}


/********** TIME CLASSIFICATION **********/

var t1 = classifySegments(img_2024_early, '2024 Early');
var t2 = classifySegments(img_2024_mid, '2024 Mid');
var t3 = classifySegments(img_2025_early, '2025 Early');
var t4 = classifySegments(img_2025_mid, '2025 Mid');

var all_time = t1.merge(t2).merge(t3).merge(t4);

print('Time Series Classification', all_time);


/********** VISUALIZATION **********/
var latest = t4.map(function(f) {

  var status = ee.String(f.get('Status'));

  var color = ee.Algorithms.If(
    status.equals('Not Started'), '#00FF00',   // bright green
    ee.Algorithms.If(
      status.equals('Under Construction'), '#FFFF00', // bright yellow
      '#FF0000' // bright red
    )
  );

  return f.set({
    style: {
      color: color,
      width: 6
    }
  });
});

Map.addLayer(latest.style({styleProperty: 'style'}), {}, 'Segment Status 2025');


/********** CHANGE DETECTION **********/

var ndvi_change = img_2025_mid.normalizedDifference(['B8','B4'])
  .subtract(img_2024_early.normalizedDifference(['B8','B4']));

Map.addLayer(ndvi_change, {
  min: -0.5,
  max: 0.5,
  palette: ['red','white','green']
}, 'NDVI Change');


/********** WATER + SLOPE **********/

var water = img_2025_mid.normalizedDifference(['B3', 'B8']).gt(0.3);

var dem = ee.Image('USGS/SRTMGL1_003');
var slope = ee.Terrain.slope(dem).clip(buffer);
var steep_slope = slope.gt(15);


/********** SUITABILITY **********/

var high_veg = img_2025_mid.normalizedDifference(['B8','B4']).gt(0.6);


var unsuitable = high_veg.or(water).or(steep_slope);
var suitable = unsuitable.not();

Map.addLayer(suitable.selfMask(), {palette: ['lightgreen']}, 'Suitable Areas');


/********** COST SURFACE **********/

var start = ee.Geometry.Point([73.56, 19.7]);

var cost = ee.Image(1)
  .add(slope.divide(30).multiply(5))
  .add(water.multiply(100))
  .add(high_veg.multiply(50))
  .clip(buffer);

Map.addLayer(cost, {min: 1, max: 10, palette: ['green','yellow','red']}, 'Cost Surface');


/********** CUMULATIVE COST **********/

var cumulative = cost.reproject({
  crs: 'EPSG:4326',
  scale: 400
}).cumulativeCost({
  source: ee.Image().toByte().paint(start, 1),
  maxDistance: 50000,
  geodeticDistance: false
});

Map.addLayer(cumulative, {
  min: 0,
  max: 2000,
  palette: ['white','purple','black']
}, 'Cumulative Cost');


/********** FINAL PATH **********/

var final_path = cumulative.lt(300);

Map.addLayer(final_path.selfMask(), {palette: ['blue']}, 'Final Corridor');


/********** EXPORT **********/

Export.image.toDrive({
  image: suitable,
  description: 'Suitable_Areas_Map',
  scale: 30,
  region: buffer,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: final_path,
  description: 'Final_Corridor',
  scale: 30,
  region: buffer,
  maxPixels: 1e13
});

Export.table.toDrive({
  collection: all_time,
  description: 'Segment_Progress_TimeSeries'
});