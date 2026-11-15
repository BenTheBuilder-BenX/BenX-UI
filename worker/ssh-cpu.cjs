// Optional native CPU detection cannot run in Workers. ssh2 uses its JavaScript crypto path.
/* global module */
module.exports = () => undefined;
