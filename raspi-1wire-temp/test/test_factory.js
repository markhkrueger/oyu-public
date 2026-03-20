'use strict';

const DS18B20DeviceController = require('../lib/controller/device_DS18B20');
const expect = require('chai').expect;
const factory = require('../lib/factory');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const StreamController = require('../lib/controller/stream');
const tmp = require('tmp');

describe('factory', function () {
    describe('API', function () {
        it('methods exist', function () {
            expect(factory).to.respondTo('findDevices');
            expect(factory).to.respondTo('fromDevice');
            expect(factory).to.respondTo('fromStream');
        });
    });

    describe('findDevices', function () {
        it('with hint', function () {
            // Create a bunch of test devices that match an expected pattern.
            const deviceOptions = {
                mode: 0o644,
                prefix: 'raspi-1wire-temp-unittest-',
                postfix: '.dev'
            };
            const numTestDevices = 2;
            const testDevices = [];
            const testDevicesNames = [];
            for (let i = 0; i < numTestDevices; i++) {
                const device = tmp.fileSync(deviceOptions);
                testDevices.push(device);
                testDevicesNames.push(path.normalize(device.name));

                const msg = "Temp test file does not exist: " + device.name;
                expect(fs.existsSync(device.name), msg).to.be.true;
            }

            try {
                // Build up a platform dependent pattern string.
                const tempDir = path.dirname(testDevicesNames[0]);
                let pattern = tempDir + '/' + deviceOptions.prefix + '*'
                    + deviceOptions.postfix;

                // Run the test.
                const devices = factory.findDevices(pattern);

                // Ensure the return devices have the right expectations.
                expect(devices).to.have.lengthOf(numTestDevices);
                expect(devices).to.have.members(testDevicesNames);
            } finally {
                testDevices.forEach(function (currentValue, index, arr) {
                    currentValue.removeCallback();
                });
            }
        });

        it('without hint', function () {
            const devices = factory.findDevices();
            expect(devices).to.be.an.instanceof(Array);

            // Since these tests are probably not run on a Raspberry Pi, chances
            // are the actual device may not be there.  The default "hint" will
            // be used, and thus no devices will be found.
            if (!fs.existsSync('/sys/bus/w1/devices')) {
                expect(devices).to.have.lengthOf(0);
            }
        });
    });

    describe('fromDevice', function () {
        it('DS18B20 controller', function () {
            const fakeDevice = sinon.fake();
            const device = factory.fromDevice(fakeDevice);
            expect(device).to.be.an.instanceof(DS18B20DeviceController);
            expect(device._filename).to.be.equal(fakeDevice);
        });
    });

    describe('fromStream', function () {
        it('stream controller', function () {
            const testDataStream = [1.1, 2.2, 3.3];

            let stream =
                factory.fromStream.apply(null, [true].concat(testDataStream));
            expect(stream).to.be.an.instanceof(StreamController);
            expect(stream._repeatable).to.be.equal(true);
            expect(stream._values).to.deep.equal(testDataStream);

            stream =
                factory.fromStream.apply(null, [false].concat(testDataStream));
            expect(stream).to.be.an.instanceof(StreamController);
            expect(stream._repeatable).to.be.equal(false);
            expect(stream._values).to.deep.equal(testDataStream);
        });
    });
});
