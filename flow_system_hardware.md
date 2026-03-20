
This document describes the hardware setup for the flow server.


Components:

- Raspberry Pi 3 Model B
- 16GB SD card imaged with OS and required software
- USB cable for power
- Ethernet cable for network connection (optional)
- 3 x DS18B20 temperature sensors (external)
- 1 x flow sensor (Hall Effect) (external)
- 1 x relay (external similar to Digital Loggers IoT Relay)
- 3 x LEDs with a single 220 ohm resistor
- Plastic enclosure (not metal too accomodate WiFi)


Internal Assembly:

There are three connectors on the front of the enclosure labeled Temperature, Flow Sensor, and Pump Control. The first two require 3 conductors, while the pump control requires 2 conductors. 
Above each of the connectors is an LED (All red in my case, but can be different colors).
    
The connectors in my build are 1/4" stereo phone jacks, and the wires are connected as follows:

Temperature:

    Tip: 3.3V
    Ring: Data
    Sleeve: Ground

Flow Sensor:

    Tip: 3.3V
    Ring: Data
    Sleeve: Ground

Pump Control:
    Tip: NC
    Ring: Data
    Sleeve: Ground

Internally the LEDS are wired in parallel with the negative leads going to a single 220 ohm resistor which is connected to ground. The positive lead of each LED is connected to a GPIO pin. The GPIO pins used are:

    * GPIO 22 (Pin 15) is the control pin which controls the HOT status LED
    * GPIO 27 (Pin 13) is the control pin which controls the flow status LED
    * GPIO 17 (Pin 11) is the control pin which controls the pump status LED

Internally there is a pullup resistor assembly with three wires going to the above listed connectors on the temperature sensor jack. The pullup assembly is connected to the Raspberry Pi GPIO pins as follows:

        Red - GPIO connector pin 4 (5V)
        Black - GPIO connector pin 6 (GND)
        Yellow - GPIO connector pin 7 (GPIO 4)

The flow sensor jack is connected to the Raspberry Pi GPIO connector as follows:

        Red - GPIO connector pin 4 (5V)
        Black - GPIO connector pin 34 (GND)
        Yellow - GPIO connector pin 32 (GPIO 12)

The pump control jack is connected to the Raspberry Pi GPIO connector as follows:

        Yellow - GPIO connector pin 37 (GPIO 26)
        Black - GPIO connector pin 39 (GND)


For self test, a jumper os connected between pins 16 and 18 of the Raspberry Pi GPIO connector. The software uses this to make sure the hardware is correctly assembled.

External cables:

The temperature sensors are all connected to a single cable with a 1/4" stereo phone plug on the end. Conductors are black (Ground), Yellow (Data) and Red (Vcc).

The flow sensor is connected to a single cable with a 1/4" stereo phone plug on the end. Conductors are black (Ground), Yellow (Data) and Red (Vcc).

Flow sensor has a JST connector with 3 conductors - red for power, black for ground and yellow for data. This is connected to a JST connector on the cable to the 1/4" stereo phone plug. The JST conductors
match as follows:

    Power on Flow sensor red - power on cable white
    Ground on Flow sensor black - ground on cable red
    Data on Flow sensor yellow - data on cable green
    
    
he pump control is connected to a single cable with a 1/4" stereo phone plug on the end. Conductors are black (Ground), Yellow (Data).

The USB cable and Ethernet cable are connected to the Raspberry Pi on the back of the enclosure. The power LED on the Raspberry Pi is visible through a hole in the enclosure.



Using an UCTRONICS GPIO T-Type Breakout Board, see https://github.com/UCTRONICS/Arducam_Starter_Kit_Python_Code_for_RPi
