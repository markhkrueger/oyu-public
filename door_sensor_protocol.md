## Door sensors are battery powered and use the HC12 wireless module to communicate with the flow server.

The sensors will broadcast data that the flow_server will listen for and process.

There can be up to 100 sensors, numbered 00-99. Each sensor will have a unique number.

Sequence numbers are used to keep track of the messages that are sent. The sequence number is incremented for each message sent by a sensor, and wraps back to 00 after hitting 99.

### Data format

Messages are UTF8 encoded text in the following format and terminated by newline character.
 OYU:$SENSOR_ID:$VERB:$DATA:$SEQ|$XSUM

Where:
- "OYU" is the message prefix
- $VERB is the type of message ("OPEN", "CLOSE", "BAT", "CPU", "SER", "VER")
- $SENSOR_ID is the two digit decimal sensor number (00-99)
- $DATA is the optional data associated with the message as a fixed number of decimal digits
- $SEQ is the two digit decimal sequence number (00-99)
- $XSUM is the two digit hexadecimal XOR of all the bytes in the message before the | character.

There are several kinds of messages the sensors will send:

1. OPEN messages.

The format for these messages is "OYU:ii:OPEN:ss:qq|xx"

Where:
- ii is the sensor number (00-99). 
- ss is the number of seconds the door has been open (00-59) if the door was closed again within some set number of seconds. A value of zero means the door was opened only for less than a second. If the door was left open for more than the limit, the message will have ss = 99, but is to be assumed that the door is open. In this case a CLOSE message will be sent when the door is closed. In no case will an OPEN message have values between 60 and 98.
- qq is a sequence number
- xx is the message checksum

This message is sent if the door was previously closed, then is opened for less than a defined number of seconds, and it is sent when the door is closed. No CLOSE message is sent in this case. In the case that the door was left open for more than the defined limit, the OPEN message will have an open time value set to 99, and a CLOSE message will be sent when the door is closed. The reason for this is that a common action is the door being opened only briefly, so only one message is sent in this case. 

2. CLOSE messages.
    
The format for these messages is "OYU:ii:CLOSE::qq|xx"   (empty data field) 

Where:
- ii is the sensor number (00-99)
- qq is the sequence number 
- xx is the message checksum

This message has no data, so the data field is empty, and will also be empty in the ACK sent back for it.

3. BATTERY messages.

The format for these messages is "OYU:ii:BAT:vvvv:qq|xx"

Where:  
- ii is the sensor number (00-99)
- vvvv is the battery voltage in millivolts (0000-9999)
- qq is the message sequence number
- xx is the message checksum

These will be used to monitor the level of the batteries in the sensor.

4. CPU_STATUS messages.

The format for these messages is "OYU:ii:CPU:tttttt:qq|xx"

Where:
- ii is the sensor number (00-99)
- tttttt is the number of seconds the CPU has been awake (000000-999999)
- qq is the message sequence number
- xx is the message checksum

5. SERIAL_STATUS messages.

The format for these messages is "OYU:ii:SER:tttttt:qq|xx"

Where:
- ii is the sensor number (00-99)
- tttttt is the number of seconds the serial chip has been awake (000000-999999)
- qq is the message sequence number
- xx is the message checksum

6. VERSION messages.

The format for these messages is "OYU:ii:VER:vvvv:qq|xx"

Where:
- ii is the sensor number (00-99)
- vvvv is the version number (0000-1999)
- qq is the message sequence number
- xx is the message checksum

- when running in production mode, the version number will start with 0, e.g. 0001 for the first version.
- when running in test mode, the version number will start with 1, e.g. 1001 for the first version.

After each of these messages is sent, if the message is valid, the server will respond by echoing back the message with "OYU" replaced by "UYO" and the XSUM value updated to be the checksum of the new message.

For example, if the sensor sends "OYU:00:OPEN:00:00|xx", the server will respond with "UYO:00:OPEN:00:00|yy" where yy is the checksum of the new message.

- A message is valid if all of the following are true:  
    - The message begins with "OYU"
    - The message is terminated by a newline character
    - The message is less than 32 bytes in length
    - The VERB field is one of the allowed VERB values
    - The SENSOR_ID field is a two digit decimal number
    - The SEQ field is a two digit decimal number
    - The DATA field is a valid data field for the given VERB  
    - The checksum is valid

 If the sensor does not receive an ACK message for the message it sent within 500ms, it will resend the message up to 3 times, with progressively longer delays.

The sequence numbers serve to identify messages sent to the server, so it knows if messages from a particular sensor were missed, and for the sensor to keep track of the last message it needs to wait for an ACK for. If the server receives a message with the same sensor ID and sequence number as a previously processed message, it will discard the duplicate without processing or sending an ACK. The sensor will exhaust its retries and move on.