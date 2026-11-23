export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Warnings, not errors: the merge queue lints the squash commit, whose body is the pull request's
    // description. A description is written for GitHub's page, one line per paragraph and one per
    // table row. The footer holds lines GitHub writes, such as `Co-authored-by:` trailers. Neither
    // the hook nor CI runs `--strict`.
    "body-max-line-length": [1, "always", 100],
    "footer-max-line-length": [1, "always", 100],
  },
};
