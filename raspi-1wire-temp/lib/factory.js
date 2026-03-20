'use strict';

const DS18B20DeviceController = require('./controller/device_DS18B20');
const StreamController = require('./controller/stream');
const glob = require('glob');
const path = require('path');

/**
 * This function either uses the supplied hint or a default glob to search for
 * potential 1-wire compatible temperature sensors.
 *
 * If the hint is supplied, this function assumes the base working directory is
 * the root directory.
 *
 * @param {String} hint A glob to search for devices.
 * @returns {Array<String>} A list of device/file names that matched the
 *      optional or default glob.
 */
module.exports.findDevices = function (hint) {
    // TODO multiple device support will need to detect different devices here.
    const pattern = hint ? hint : '/sys/bus/w1/devices/28-*/w1_slave';
    let files = glob.sync(pattern);
    files = files.map(f => path.normalize(f));
    return files;
};

/**
 * Creates a temperature controller from the supplied device.
 *
 * @param {String} device The device to wrap with a temperature controller.
 * @returns {ControllerIf} A temperature controller backed by the supplied device.
 */
module.exports.fromDevice = function (device) {
    // TODO multiple device support will need to determine which kind of device ctrlr to construct.
    // TODO might make sense to have a more complex output from findDevices with many dev cntrlrs.
    return new DS18B20DeviceController(device);
};

/**
 * Creates an emulated stream of temperatures from the given stream.  If the
 * stream is not repeatable then an exception is raised once the data stream has
 * been exhausted.
 *
 * @param repeatable Boolean flag indicating if the stream should repeat.
 * @param stream The data stream itself.
 * @returns {ControllerIf}
 */
module.exports.fromStream = function (repeatable, ...stream) {
    return new StreamController(repeatable, ...stream)
};
