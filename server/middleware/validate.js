// replaces req[source] with the parsed (trimmed, typed) data
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
      return res.status(400).json({ error: where + issue.message });
    }
    req[source] = result.data;
    next();
  };
}
