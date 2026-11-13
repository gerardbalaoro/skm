import { realpath } from 'fs/promises';

/** Display only the selected skills lockfile’s records and the local installation path. */
export interface SkillProvenance {
  source: string;
  recordedBy: string;
  skillPath?: string;
  version?: string;
  ref?: string;
  commit?: string;
  contentHash?: string;
  location?: string;
}

interface LockedProvenance {
  source: string;
  sourceUrl?: string;
  sourceBaseUrl?: string;
  skillPath?: string;
  version?: string;
  ref?: string;
  commit?: string;
  computedHash?: string;
  skillFolderHash?: string;
}

/** A local directory or symlink does not establish a skill’s upstream source or version. */
export async function readSkillProvenance(
  path: string | undefined,
  locked?: LockedProvenance
): Promise<SkillProvenance> {
  const location = path ? await realpath(path).catch(() => path) : undefined;
  if (locked) {
    return {
      source: locked.sourceBaseUrl ?? locked.sourceUrl ?? locked.source,
      recordedBy: 'skills lockfile',
      skillPath: locked.skillPath,
      version: locked.version,
      ref: locked.ref,
      commit: locked.commit,
      contentHash: locked.computedHash || locked.skillFolderHash || undefined,
      location,
    };
  }
  return { source: 'Unknown (no source recorded)', recordedBy: 'No source record', location };
}

/** Keep refs, package versions and content hashes distinct; hashes are not release versions. */
export function describeSkillProvenance(provenance: SkillProvenance): string[] {
  return [
    `Source: ${provenance.source}`,
    `Recorded by: ${provenance.recordedBy}`,
    `Version: ${provenance.version ?? 'Not recorded'}`,
    `Git ref: ${provenance.ref ?? 'Not recorded'}`,
    `Recorded commit: ${provenance.commit ?? 'Not recorded'}`,
    ...(provenance.skillPath ? [`Source path: ${provenance.skillPath}`] : []),
    ...(provenance.contentHash ? [`Content hash: ${provenance.contentHash}`] : []),
    ...(provenance.location ? [`Location: ${provenance.location}`] : []),
  ];
}
