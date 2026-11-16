import packageJson from '../../package.json' with { type: 'json' };

/** Version of the installed `@gblab/skm` package. */
export const version: string = packageJson.version;
