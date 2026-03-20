'use strict';

const StreamController = require('../../lib/controller/stream');
const expect = require('chai').expect;

describe('controller', function () {
    describe('stream', function () {

        describe('constructor()', function () {
            it("class can be instantiated", function () {
                const emulator = new StreamController(false, 1, 2, 3);
                expect(emulator).to.respondsTo('_readData');
                expect(emulator).to.respondsTo('_parseData');
                expect(emulator._repeatable).to.equal(false);
                expect(emulator._values).to.deep.equal([1, 2, 3]);
                expect(emulator._index).to.equal(0);
            });
        });

        describe('_readData()', function () {
            it('repeats data', function () {
                const emulator = new StreamController(true, 1.1, 2.2, 3.3);
                expect(emulator._repeatable).to.equal(true);

                expect(emulator._index).to.equal(0);
                expect(emulator._readData()).to.equal(1.1);
                expect(emulator._readData()).to.equal(2.2);
                expect(emulator._readData()).to.equal(3.3);

                expect(emulator._index).to.equal(0);
                expect(emulator._readData()).to.equal(1.1);
                expect(emulator._readData()).to.equal(2.2);
                expect(emulator._readData()).to.equal(3.3);

                expect(emulator._index).to.equal(0);
            });

            it('not repeatable', function () {
                const emulator = new StreamController(false, 1.1, 2.2, 3.3);
                expect(emulator._repeatable).to.equal(false);

                expect(emulator._index).to.equal(0);
                expect(emulator._readData()).to.equal(1.1);
                expect(emulator._readData()).to.equal(2.2);
                expect(emulator._readData()).to.equal(3.3);

                expect(emulator._index).to.equal(3);
                expect(() => emulator._readData()).to.throw(
                    Error, 'Non-repeatable stream exhausted all data.');
            });
        });

        describe('_parseData()', function () {
            it('returns the raw data as parsed data', function () {
                const emulator = new StreamController(false, 1, 2, 3);
                expect(emulator._repeatable).to.equal(false);

                expect(emulator._parseData(123)).to.equal(123);
                expect(emulator._parseData(321)).to.equal(321);
                expect(emulator._parseData('abc')).to.equal('abc');
            });
        });
    });
});
