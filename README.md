
    ⚠️ **DISCLAIMER: HIGH VOLTAGE AND WATER DANGER** ⚠️

    This project involves mains voltage electricity and pressurized hot water. **DO NOT** attempt to build or install this system unless you are qualified to do so. Improper wiring or plumbing can result in **electrocution, severe burns, property damage from flooding, or death**. 
    
    This documentation and software are provided for educational purposes only. By using these files, you assume all risks. The authors take absolutely **NO RESPONSIBILITY** for any damage, injury, or legal compliance issues resulting from the use or misuse of this information. Always consult local electrical and plumbing codes before beginning any work.

    It is your sole responsibility to ensure that anything you build complies with all applicable local laws, regulations, building codes (e.g., NEC, UPC), and insurance policies. Requirements vary by country, state, and municipality.


This is a project to control a hot water system for a house with recirculating hot water. Typically such a system is used with a regular tank water heater and a pump to circulate the water. When replacing the water heater with a tankless water heater, the pump is no longer needed to provide faster hot water, and running the pump continuously wastes electricity since the tankless water heater turns on whenever flow is detected. Another issue is that for the equivalent usage of hot water, an eletric tankless water heater at the same electric current rating is not able to provide the same flow rate as a tank water heater. One way to circumvent this is to utilize the recirculation system to recirculate the water continually while hot water is being used, which reduces the energy needed to heat the water since only a portion is now coming from the cold source water. For this to be efficient it should only run when hot water is being used, which is not always the case. Note, that I live in an area with fairly warm ground water, if the ground water is very cold even a recirculation pump may not be enough to keep the water warm with an electric tankless water heater rated the same as a tank water heater. In that case, a larger electric tankless water heater would be needed, or a hybrid system with a small buffer tank would be needed.


One way to do this is what I originally set up in my house, which was to connect the hot water recirculation pump to a smart plug and then use HomeKit to control the smart plug. I added a wireless switch near each shower/bath and then used HomeKit automations to turn on the pump when either switch was pressed and turn it off after 10 minutes. This worked reasonably well, but it was not very efficient since the pump would run for 10 minutes after the last switch was pressed.

I upgraded my plumbing to add a one-way valve and hall effect flow sensor which can detect when source water is entering the hot water recirculation loop. Then I created this project which uses a Raspberry Pi to read the flow sensor and control the recirculation pump. This is more efficient since the pump only runs when hot water is being used. I also added temperature sensors for the source water, the hot water loop and the ambient temperature in the utility closet where the equipment is housed.

The system is controlled by a Raspberry Pi which runs a Node.js application that reads the flow sensor and controls the recirculation pump. The system is also accessible via HomeKit, so it can be controlled and monitored by HomeKit automations. The system is also accessible via a web interface, which can be used to monitor the system and see details on water, energy, pump and heater usage.

## Hardware References

- [3/4" NPT Hall Sensor Flow Meter](https://smartrecirculationcontrol.com/3-4-npt-hall-sensor-flow-meter/) — flow sensor used to detect water movement
- [Raspberry Pi 3 GPIO Pinout](https://www.youngwonks.com/blog/Raspberry-Pi-3-Pinout) — GPIO pin reference diagram
- [DS18B20 Temperature Sensor Datasheet](https://cdn.sparkfun.com/datasheets/Sensors/Temp/DS18B20.pdf) — 1-wire temperature sensor spec sheet

## License

This project is licensed under the [MIT License](LICENSE).

## Third-Party Licenses

This project uses the following open source libraries:

### Runtime Dependencies

| Package | License |
|---|---|
| [@homebridge/hap-nodejs](https://github.com/homebridge/HAP-NodeJS) | Apache-2.0 |
| [async-mutex](https://github.com/DirtyHairy/async-mutex) | MIT |
| [glob](https://github.com/isaacs/node-glob) | ISC |
| [ip](https://github.com/indutny/node-ip) | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | MIT |
| [rpi-gpio](https://github.com/JamesBarwell/rpi-gpio.js) | MIT |
| [systeminformation](https://github.com/sebhildebrandt/systeminformation) | MIT |
| [table](https://github.com/gajus/table) | BSD-3-Clause |

### Dev Dependencies

| Package | License |
|---|---|
| [@typescript-eslint/eslint-plugin](https://github.com/typescript-eslint/typescript-eslint) | MIT |
| [@typescript-eslint/parser](https://github.com/typescript-eslint/typescript-eslint) | BSD-2-Clause |
| [eslint](https://github.com/eslint/eslint) | MIT |
| [jest](https://github.com/jestjs/jest) | MIT |
| [ts-jest](https://github.com/kulshekhar/ts-jest) | MIT |

All third-party licenses are permissive open source licenses (MIT, Apache-2.0, ISC, BSD). See each package's repository for full license text.
