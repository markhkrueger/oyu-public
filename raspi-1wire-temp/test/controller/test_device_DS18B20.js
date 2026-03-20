'use strict';

const DS18B20Controller = require('../../lib/controller/device_DS18B20');
const expect = require('chai').expect;
const fs = require('fs');
const tmp = require('tmp');

// Cleanup the temporary files even when an uncaught exception occurs
tmp.setGracefulCleanup();

/** Valid raw data used for testing. */
const VALID_RAW_DATA =
    '72 01 4b 46 7f ff 0e 10 57 : crc=57 YES\n' +
    '72 01 4b 46 7f ff 0e 10 57 t=23125';

/** The hex value in the valid raw test data. */
const VALID_RAW_DATA_HEX = '72 01 4b 46 7f ff 0e 10 57';

/** The crc value in the valid raw test data. */
const VALID_RAW_DATA_CRC = '57';

/** The crc validity flag in the valid raw test data. */
const VALID_RAW_DATA_CRC_OK = true;

/** The temperature value in the valid raw test data. */
const VALID_RAW_DATA_TEMP = parseInt('23125') / 1000.0;

/**
 * Invalid raw data used for testing. The property missing about this data to
 * make it invalid is the fact that it is only one line long.
 */
const INVALID_RAW_DATA = VALID_RAW_DATA.replace('\n', '');

/** The minimum delta allowed when comparing floating-point numbers. */
const TEMP_DELTA = 0.1;

describe('controller', function () {
    describe('device-DS18B20', function () {

        beforeEach('initializing temporary temperature file', function () {
            this.tempDevice = tmp.fileSync({
                mode: 0o644,
                prefix: 'raspi-1wire-temp-unittest-',
                postfix: '.dev'
            });
            fs.writeSync(this.tempDevice.fd, VALID_RAW_DATA);
        });

        afterEach('deleting temporary temperature file', function () {
            this.tempDevice.removeCallback();
        });

        describe('constructor', function () {
            it('class can be instantiated', function () {
                const controller = new DS18B20Controller(this.tempDevice.name);
                expect(controller).to.respondsTo('_readData');
                expect(controller).to.respondsTo('_parseData');
                expect(controller._filename).to.equal(this.tempDevice.name);
                expect(controller.hex).to.equal(null);
                expect(controller.crc).to.equal(null);
                expect(controller.crcValid).to.equal(false);
            });
        });

        describe('_readData', function () {
            it('device does not exist', function () {
                const expectedErrorMessage =
                    '1-Wire compatible file/device does not exist: '
                    + this.tempDevice.name;

                // Delete the temp file early.
                this.tempDevice.removeCallback();

                const controller = new DS18B20Controller(this.tempDevice.name);
                expect(() => controller._readData()).to.throw(
                    Error, expectedErrorMessage);
            });

            it('can read data', function () {
                const controller = new DS18B20Controller(this.tempDevice.name);
                expect(controller._readData()).to.equal(VALID_RAW_DATA);
            });
        });

        describe('_parseData', function () {
            it('invalid data', function () {
                const controller = new DS18B20Controller(this.tempDevice.name);
                expect(() => controller._parseData(INVALID_RAW_DATA))
                    .to.throw(Error, 'Raw data does not have a valid length.');
            });

            it('can parse data', function () {
                const controller = new DS18B20Controller(this.tempDevice.name);
                const rawTemperature = controller._parseData(VALID_RAW_DATA);

                expect(rawTemperature).to.be.closeTo(
                    VALID_RAW_DATA_TEMP, TEMP_DELTA);
                expect(controller.hex).to.equal(VALID_RAW_DATA_HEX);
                expect(controller.crc).to.equal(VALID_RAW_DATA_CRC);
                expect(controller.crc_ok).to.equal(VALID_RAW_DATA_CRC_OK);
            });
        });
    });
});
