'use strict';

const ControllerIf = require('../../lib/controller/controller');
const Temperature = require('../../lib/model/temperature');
const expect = require('chai').expect;
const sinon = require('sinon');

class TestController extends ControllerIf {
    constructor() {
        super();
    }
}

describe('controller', function () {
    describe('controller', function () {

        describe('constructor()', function () {
            it('cannot create instance of base class', function () {
                const func = function () {
                    new ControllerIf();
                };
                expect(func).to.throw(
                    TypeError,
                    'Cannot construct ControllerIf instances directly.');
            });

            it("subclass can be instantiated", function () {
                expect(TestController.constructor).to.not.equal(null);
            });
        });

        describe('current()', function () {
            it('sub-class methods called', function () {
                const controller = new TestController();

                // Setup sub-class implementation.
                const rawData = 'apple pie';
                const rawTemp = 12300;
                controller._readData = sinon.fake.returns(rawData);
                controller._parseData = sinon.fake.returns(rawTemp);

                // Run the test.
                const temp = controller.current;

                // Verify expectations.
                expect(controller._readData.callCount).to.equal(1);
                expect(controller._parseData.callCount).to.equal(1);
                expect(temp.celsius).to.equal(rawTemp);
            });
        });

        describe('_createTemp()', function () {
            it('wraps parsed temp into Temperature object', function () {
                const controller = new TestController();
                const parsedTemp = 321;
                const temp = controller._createTemp(parsedTemp);
                expect(temp).to.be.an.instanceOf(Temperature);
                expect(temp.celsius).to.equal(parsedTemp);
            });
        });

        describe('_readData()', function () {
            it('base class throws exception', function () {
                const controller = new TestController();
                expect(controller._readData).to.throw(
                    Error, 'Subclass did not implement method.');
            });
        });

        describe('_parseData()', function () {
            it('base class throws exception', function () {
                const controller = new TestController();
                expect(controller._parseData).to.throw(
                    Error, 'Subclass did not implement method.');
            });
        });
    });
});
