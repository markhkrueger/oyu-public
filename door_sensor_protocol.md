## Door sensors are battery powered and use the HC12 wireless module to communicate with the flow server.

The sensors will broadcast data that the flow_server will listen for and process.

### Data format

There are several kinds of messages the sensors will send:

1. DOOR_OPEN messages.

The format for these messages is "DOORii:OPEN:ss#qq"

Where:
- ii is the sensor number (00-99)
- ss is the number of seconds the door has been open (00-59) if the door was closed within 60 seconds. If the door was open for more than 60 seconds, the message will have ss = 60, but is assumed the door is open. In this case a DOOR_CLOSE message will be sent when the door is closed.
- qq is a sequence number which increments from 0-99

This message is sent if the door was previously closed, then is opened for less than 60 seconds, and it is sent when the door is closed. No DOOR_CLOSE message is sent in this case. In the case that the door was left open for more than 60 seconds, a DOOR_CLOSE message will be sent when the door is closed.

2. DOOR_CLOSE messages.

The format for these messages is "DOORii:CLOSE#qq"

Where:
- ii is the sensor number (00-99)
- qq is a sequence number which increments from 0-99

3. BATTERY messages.

The format for these messages is "BATii:vvvv#qq"

Where:  
- ii is the sensor number (00-99)
- vvvv is the battery voltage in millivolts (0000-9999)
- qq is a sequence number which increments from 0-99    

4. CPU_STATUS messages.

The format for these messages is "CPUii:ttttttHCssssss-mmmm#qq"

Where:
- ii is the sensor number (00-99)
- tttttt is the number of seconds the CPU has been awake (000000-999999)
- ssssss is the number of seconds the HC12 has been awake (000000-999999)
- mmmm is either TEST or PROD indicating if the device is running in development mode or production mode
- qq is a sequence number which increments from 0-99    

The server will use this message to keep track of how long the sensor has been awake and how long the HC12 has been awake. It will also use this message to determine if the sensor is running in development mode or production mode. 


After each of these messages is sent, the server will respond with an ACK message in the format:

"ACKii:qq#

Where ii is the sensor number and qq is the sequence number of the message that was sent. If the sensor does not receive an ack message for the message it sent within 500ms, it will resend the message up to 3 times, with progressively longer delays.
