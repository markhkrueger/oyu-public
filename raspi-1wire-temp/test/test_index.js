'use strict';

const expect = require('chai').expect;
const factory = require('../lib/factory');
const r1wt = require('../');

describe('factory', function () {
    describe('API', function () {
        it('raspi-1wire-temp === factory', function () {
            expect(r1wt).to.deep.equal(factory);
        });
    });
});
