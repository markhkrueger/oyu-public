The flow sensor is connected to the Raspberry PI via GPIO pins.

GPIO Pinout

| Device/Function | Pin Name | Pin # | Pin # | Pin Name | Device/Function |
| :-------------- | :------- | :---: | :---: | :------- | :---------------- |
|                 |          |   1   |   2   | 5V       |                   |
|                 |          |   3   |   4   | 5V       |                   |
|                 |          |   5   |   6   | GND      |                   |
| Temperature     | GPIO 4   |   7   |   8   | GPIO14   | TXD               |
|                 |          |   9   |  10   | GPIO15   | RXD               |
| Pump LED (Blue) | GPIO 17  |  11   |  12   |          |                   |
| Flow LED (Purple)| GPIO 27 |  13   |  14   |          |                   |
| HOT LED (Yellow)| GPIO 22  |  15   |  16   | GPIO 23  | Loop (out)        |
|                 |          |  17   |  18   | GPIO 24  | Loop (in)         |
|                 |          |  19   |  20   |          |                   |
|                 |          |  21   |  22   |          |                   |
|                 |          |  23   |  24   |          |                   |
|                 |          |  25   |  26   |          |                   |
|                 |          |  27   |  28   |          |                   |
|                 |          |  29   |  30   |          |                   |
|                 |          |  31   |  32   | GPIO 12  | Flow              |
| HC12-SET        | GPIO 13  |  33   |  34   | GND      |                   |
|                 |          |  35   |  36   | GPIO 16  | Heater sensor     |
| Pump            | GPIO 26  |  37   |  38   |          |                   |
|                 | GND      |  39   |  40   |          |                   |


The flow sensor has three pins:

    * Black: GND
    * Red: VCC
    * Yellow: PULSE

The flow sensor is connected to the Raspberry PI via GPIO pins.

    * 5V power Pin 4 Jumper is red
    * GND Pin 34 Jumper is black
    * PULSE GPIO 12 (Pin 32) jumper is orange

For testing the loopback functionality, connect the PULSE pin to the BCM 26 (pin 37) and run the server with the -l option. 


All DS18B20 temperature sensors share a single 1-wire bus on GPIO 4 (Pin 7).
A 4.7k pull-up resistor is required between DATA and VCC.
The kernel overlay `dtoverlay=w1-gpio` in /boot/config.txt enables this bus.

The DS18B20 temperature sensor has three pins:

    * Black: GND
    * Red: VCC
    * Orange: DATA

Temperature Sensors
    * 5V power Pin 2
    * GND Pin 6
    * DATA GPIO 4 (Pin 7) — shared 1-wire bus

The pump is connected to the Raspberry PI via GPIO pins.

    * GPIO 26 (Pin 37) is the control pin which controls a relay for the pump 

For testing of gpio functionality, connect a jumper between GPIO 23 and GPIO 24 (pins 16 and 18)

Three status LEDs are connected to the Raspberry PI via GPIO pins.

    * GPIO 22 (Pin 15) is the control pin which controls the HOT status LED
    * GPIO 27 (Pin 13) is the control pin which controls the flow status LED
    * GPIO 17 (Pin 11) is the control pin which controls the pump status LED
