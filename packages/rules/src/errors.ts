export const RulesErrorCodes = {
  /** A rule or exception names an unknown decision point or a value the point does not take. */
  invalid: 'E_RULE_INVALID',
  notFound: 'E_RULE_NOT_FOUND',
  exists: 'E_RULE_EXISTS',
  /** The fallback rule of a decision point cannot be disabled. */
  protected: 'E_RULE_PROTECTED',
  checkFailed: 'E_RULES_CHECK',
  lintFailed: 'E_RULES_LINT',
} as const;
