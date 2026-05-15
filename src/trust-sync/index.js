module.exports = {
  ...require('./symbol-links'),
  ...require('./related-memory'),
  trustPolicy: require('./trust-policy'),
  changeDetector: require('./change-detector'),
};
