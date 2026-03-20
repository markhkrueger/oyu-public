'use strict';

const ControllerIf = require('./controller');

/** A temperature controller sourced by a data stream. */
class StreamController extends ControllerIf {

    /**
     * Constructs a new streaming data controller.
     *
     * @param repeatable Boolean flag indicating if the stream should repeat
     *      once the data has been exhausted.
     * @param values The celsius values to stream
     */
    constructor(repeatable, ...values) {
        super();
        this._repeatable = Boolean(repeatable);
        this._values = Array.from(values);
        this._index = 0;
    }

    /**
     * Retrieves the next available temperature value in the stream.  If the
     * stream is not repeatable and exhausted, then an error will be raised.
     *
     * @see controller._ControllerIf._readData
     *
     * @returns {ReadonlyArray<any>} The raw device data.
     * @throws {Error} If a non-repeatable stream exhausted its data source.
     * @private
     */
    _readData() {
        if (this._index === this._values.length) {
            throw Error('Non-repeatable stream exhausted all data.');
        }

        try {
            return this._values[this._index];
        } finally {
            this._index++;
            if (this._repeatable) {
                this._index %= this._values.length;
            }
        }
    }

    /**
     * Returns the raw data as the temperature in celsius.
     *
     * @see controller._ControllerIf._parseData
     *
     * @param rawData The raw device data returned from `this._readData()`.
     * @returns {number} The temperature in celsius.
     * @private
     */
    _parseData(rawData) {
        return rawData;
    }
}

/**
 * Exports a streaming data controller.
 *
 * @type {StreamController}
 */
module.exports = StreamController;
