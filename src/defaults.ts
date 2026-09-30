/** A lower policy layer; explicit global/project/agent rules override it. */
export const kitPermission = {
  '*': 'ask', read: 'allow', ls: 'allow', grep: 'allow', find: 'allow',
  path_read: 'allow', path_write: 'ask',
  external_directory_read: 'allow', external_directory_write: 'ask',
  bash: 'ask', subagent: 'allow', get_subagent_result: 'allow', steer_subagent: 'allow',
} as const;
