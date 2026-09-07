declare const idBrand: unique symbol;

type BrandedId<Kind extends string> = string & {
  readonly [idBrand]: Kind;
};

export type EngineId = BrandedId<'EngineId'>;
export type DeviceId = BrandedId<'DeviceId'>;
export type DatastreamId = BrandedId<'DatastreamId'>;
export type AssetId = BrandedId<'AssetId'>;
export type ApplicationId = BrandedId<'ApplicationId'>;
export type PluginTypeId = BrandedId<'PluginTypeId'>;

const asBrandedId = <Kind extends string>(value: string): BrandedId<Kind> =>
  value as BrandedId<Kind>;

export const asEngineId = (value: string): EngineId => asBrandedId<'EngineId'>(value);
export const asDeviceId = (value: string): DeviceId => asBrandedId<'DeviceId'>(value);
export const asDatastreamId = (value: string): DatastreamId => asBrandedId<'DatastreamId'>(value);
export const asAssetId = (value: string): AssetId => asBrandedId<'AssetId'>(value);
export const asApplicationId = (value: string): ApplicationId =>
  asBrandedId<'ApplicationId'>(value);
export const asPluginTypeId = (value: string): PluginTypeId => asBrandedId<'PluginTypeId'>(value);

const encodeNameSegment = (name: string): string =>
  encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const deviceIdForName = (name: string): DeviceId => asDeviceId(encodeNameSegment(name));

export const datastreamIdForNames = (deviceName: string, datastreamName: string): DatastreamId =>
  asDatastreamId(`${encodeNameSegment(deviceName)}/${encodeNameSegment(datastreamName)}`);

export const assetIdForName = (name: string): AssetId => asAssetId(encodeNameSegment(name));

export const applicationIdForNames = (assetName: string, applicationName: string): ApplicationId =>
  asApplicationId(`${encodeNameSegment(assetName)}/${encodeNameSegment(applicationName)}`);
