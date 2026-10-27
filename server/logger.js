import config from './config.js';

const stamp = () => new Date().toISOString();

const logger = {
  info: (...a) => !config.isTest && console.log(stamp(), ...a),
  warn: (...a) => !config.isTest && console.warn(stamp(), 'WARN', ...a),
  error: (...a) => console.error(stamp(), 'ERROR', ...a),
};

export default logger;
