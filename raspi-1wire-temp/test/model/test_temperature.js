'use strict';

const expect = require('chai').expect;
const Temperature = require('../../lib/model/temperature');

/** The minimum delta allowed when comparing floating-point numbers. */
const TEMP_DELTA = 0.1;

describe('model', function () {
    describe('temperature', function () {

        it('30 is hot', function () {
            const temp = new Temperature(30);
            expect(temp.celsius).to.be.closeTo(30.0, TEMP_DELTA);
            expect(temp.fahrenheit).to.be.closeTo(86.0, TEMP_DELTA);
        });

        it('20 is nice', function () {
            const temp = new Temperature(20);
            expect(temp.celsius).to.be.closeTo(20.0, TEMP_DELTA);
            expect(temp.fahrenheit).to.be.closeTo(68.0, TEMP_DELTA);
        });

        it('10 wear a jacket', function () {
            const temp = new Temperature(10);
            expect(temp.celsius).to.be.closeTo(10.0, TEMP_DELTA);
            expect(temp.fahrenheit).to.be.closeTo(50.0, TEMP_DELTA);
        });

        it('0 is ice', function () {
            const temp = new Temperature(0);
            expect(temp.celsius).to.be.closeTo(0.0, TEMP_DELTA);
            expect(temp.fahrenheit).to.be.closeTo(32.0, TEMP_DELTA);
        });
    });
});
