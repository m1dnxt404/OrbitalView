import { z } from "zod";

// GeoJSON primitives — feature properties use z.record() since aircraft vs
// earthquake shapes differ and deep validation adds no safety value here.
const GeoJSONPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z
    .tuple([z.number(), z.number()])
    .or(z.tuple([z.number(), z.number(), z.number()])),
});

const GeoJSONFeatureSchema = z.object({
  type: z.literal("Feature"),
  geometry: GeoJSONPointSchema,
  properties: z.record(z.unknown()).nullable(),
});

const GeoJSONFeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(GeoJSONFeatureSchema),
});

const TLERecordSchema = z.object({
  norad_id: z.number(),
  name: z.string(),
  line1: z.string(),
  line2: z.string(),
});

export const WorldPayloadSchema = z.object({
  aircraft: GeoJSONFeatureCollectionSchema,
  military: GeoJSONFeatureCollectionSchema,
  tles: z.array(TLERecordSchema),
  earthquakes: GeoJSONFeatureCollectionSchema,
  counts: z.object({
    aircraft: z.number(),
    military: z.number(),
    satellites: z.number(),
    earthquakes: z.number(),
  }),
  timestamp: z.number(),
});
