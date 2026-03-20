
The flow server runs on the Raspberry PI computer which has two or more temperature sensors and a flow sensor attached via GPIO pins. It is a simple HTTP server which reports the temperature and flow data to a control server.

HTTP GET requests are used to retrieve the temperature and flow data. The data is returned in JSON format.

GET Status
Arguments: None 
Returns: JSON object containing the status of the flow server.

Status is returned as a JSON object with the following properties:

    * time: The current time in ISO format.
    * temperature: The current temperature in Celsius.
    * flow: The current flow in liters per minute.
    * start: The time the server started in ISO format.
    * status: text description of the status (OK, ERROR, etc.)
    * error: text description of the error, if there is a problem


GET Temperature
Arguments: Sensor number (1,2,3,4)
Returns: JSON object containing the temperature of the specified sensor.    

Temperature is returned as a JSON object with the following properties:

    * time: The current time in ISO format.
    * temperature: The current temperature in Celsius.
    * time since last change: The time since the last temperature change in seconds.

GET Flow
Arguments: None
Returns: JSON object containing the flow data.

Flow is returned as a JSON object with the following properties:

    * time: The current time in ISO format.
    * flow: The current flow in liters per minute.
    * time since last change: The time since the last flow change in seconds.   


Command Line Arguments

-v --version
    Print the version of the flow server and exit.

-h --help
    Print the help message and exit.

-t --temperature <sensor number>
    Print the temperature of the specified sensor and exit.
    Sensor number is 1,2,3,4 for the four temperature sensors.

-f --flow
    Print the flow rate and exit.       

-s --start <port number>
    Start running the HTTP server on the specified port number and keep running.
    The server will run until it is stopped by the user.


Temperature Sensors are connected wia 1-wire protocol to GPIO4 (pin 7).
Three temperature sensors are expected, one for the cold water inlet, one for the hot water outlet and one for the ambient temperature.

A flow sensor is connected to GPIO12 (Pin 32) and is used to measure the flow rate of the water.

A pump is connected to GPIO26 (Pin 37) and is used to control the flow of water.

Three status LEDs are connected to the Raspberry PI via GPIO pins.

    * GPIO 22 (Pin 15) is the control pin which controls the HOT status LED

    This LED will be illuminated only when the hot water temperature is above the set point (40 degrees C)

    * GPIO 27 (Pin 13) is the control pin which controls the flow status LED

    This LED will flash slowly if the flow is under 1 liter per minute, but over zer0, and will flash quickly if the flow is above 1 liter per minute.
    If the flow is zero, the LED will be off.

    * GPIO 17 (Pin 11) is the control pin which controls the pump status LED

    This LED will be illuminated when the pump is running.


Systemd Service

The flow server can be run as a systemd service so that it starts automatically at boot and restarts on failure. A service unit file is provided as flow-server.service.

Install the service:

    sudo cp flow-server.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable flow-server
    sudo systemctl start flow-server

After deploying updated code, restart the service:

    sudo systemctl restart flow-server

Useful commands:

    sudo systemctl status flow-server       Check if running
    sudo systemctl stop flow-server         Stop the service
    journalctl -u flow-server -f            Tail live logs
    journalctl -u flow-server --since today View today's logs

The service is configured with Restart=on-failure and RestartSec=5, so systemd will automatically restart it 5 seconds after any crash. It runs as user mark from /home/mark/flow.
