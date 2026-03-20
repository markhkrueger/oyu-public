module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/out/', '/build/'],
  modulePathIgnorePatterns: ['/out/', '/build/'],
};
