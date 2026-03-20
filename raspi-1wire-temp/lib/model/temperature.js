'use strict';

/**
 * A temperature container that derives actual temperatures from raw device
 * data.
 */
class Temperature {

    /**
     * Constructs a new temperature container from the value from a 1-wire
     * compatible temperature device.
     *
     * @param celsius The celsius temperature.
     * @constructor
     */
    constructor(celsius) {
        this._celsius = Object.freeze(celsius);
    }

    /** @returns {number} The temperature in celsius. */
    get celsius() {
        return this._celsius;
    };

    /** @returns {number} The temperature in fahrenheit. */
    get fahrenheit() {
        return (this.celsius * 1.8) + 32.0;
    };
}

/**
 * Exports the temperature container.
 *
 * @type {Temperature}
 */
module.exports = Temperature;
