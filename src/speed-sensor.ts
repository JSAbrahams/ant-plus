/// <reference path="../typings/index.d.ts"/>

import Ant = require('./ant');

const Messages = Ant.Messages;
const Constants = Ant.Constants;

class SpeedSensorState {
	constructor(deviceID: number) {
		this.DeviceID = deviceID;
	}

	DeviceID: number;

	eventTime: number;
	revolutionCount: number;

	CalculatedSpeed: number;
	CalculatedCadence: number;
	CalculatedDistance: number;
}

class SpeedScanState extends SpeedSensorState {
	Rssi: number;
	Threshold: number;
}

const updateState = function (sensor: SpeedSensor | SpeedScanner,
							  state: SpeedSensorState | SpeedScanState, data: Buffer) {
	//get old state for calculating cumulative values
	const oldRevolutionCount = state.revolutionCount;
	const oldEventTime = state.eventTime;
	
	let eventTime = data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 4);
	eventTime |= data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 5) << 8;

	let revolutionCount = data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 6);
	revolutionCount |= data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 7) << 8;

	if (revolutionCount !== oldRevolutionCount) {
		state.revolutionCount = revolutionCount;
		state.eventTime = eventTime;

		if (oldEventTime > eventTime) { //Hit rollover value
			eventTime += 1024 * 64;
		}
		if (oldRevolutionCount > revolutionCount) {
			revolutionCount += 1024 * 64;
		}

		const revolutions = revolutionCount - oldRevolutionCount;
		const elapsedTime = eventTime - oldEventTime;

		state.CalculatedSpeed = sensor.wheelCircumference * revolutions * 1024 / elapsedTime; // M/s
		state.CalculatedCadence = 60 * revolutions * 1024 / elapsedTime; // rpm

		if (elapsedTime > 5 * 1024) {
			sensor.revolutions = 0;
		}

		sensor.revolutions += revolutions;
		state.CalculatedDistance = sensor.wheelCircumference * sensor.revolutions;

		sensor.emit('speedData', state);
	}
};

/*
 * ANT+ profile: https://www.thisisant.com/developer/ant-plus/device-profiles/#523_tab
 * Spec sheet: https://www.thisisant.com/resources/bicycle-speed-and-cadence/
 */
export class SpeedSensor extends Ant.AntPlusSensor {
	channel: number;

	static deviceType = 0x7b;
	static timeout = Constants.TIMEOUT_NEVER;
	static transmissionType = 0;
	static channelPeriod = 8118;

	state: SpeedSensorState;
	wheelCircumference: number = 2.118; //This is my 700c wheel, just using as default
	revolutions = 0;

	setWheelCircumference(wheelCircumference: number) {
		this.wheelCircumference = wheelCircumference;
	}

	constructor(stick) {
		super(stick);
		this.decodeDataCbk = this.decodeData.bind(this);
	}

	public attach(channel, deviceID): void {
		super.attach(channel, 'receive', deviceID, SpeedSensor.deviceType, SpeedSensor.transmissionType,
			SpeedSensor.timeout, SpeedSensor.channelPeriod);
		this.state = new SpeedSensorState(deviceID);
	}

	decodeData(data: Buffer) {
		let channel = data.readUInt8(Messages.BUFFER_INDEX_CHANNEL_NUM);
		let type = data.readUInt8(Messages.BUFFER_INDEX_MSG_TYPE);

		if (channel !== this.channel) {
			return;
		}

		switch (type) {
			case Constants.MESSAGE_CHANNEL_BROADCAST_DATA:
				if (this.deviceID === 0) {
					this.write(Messages.requestMessage(this.channel, Constants.MESSAGE_CHANNEL_ID));
				}

				updateState(this, this.state, data);
				break;

			case Constants.MESSAGE_CHANNEL_ID:
				this.deviceID = data.readUInt16LE(Messages.BUFFER_INDEX_MSG_DATA);
				this.transmissionType = data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 3);
				this.state.DeviceID = this.deviceID;
				break;
			default:
				break;
		}
	}

}

export class SpeedScanner extends Ant.AntPlusScanner {
	static deviceType = 0x7b;
	wheelCircumference: number = 2.118; //This is my 700c wheel, just using as default
	revolutions = 0;

	states: { [id: number]: SpeedScanState } = {};

	constructor(stick) {
		super(stick);
		this.decodeDataCbk = this.decodeData.bind(this);
	}

	setWheelCircumference(wheelCircumference: number) {
		this.wheelCircumference = wheelCircumference;
	}

	public scan() {
		super.scan('receive');
	}

	decodeData(data: Buffer) {
		if (data.length <= Messages.BUFFER_INDEX_EXT_MSG_BEGIN || !(data.readUInt8(Messages.BUFFER_INDEX_EXT_MSG_BEGIN) & 0x80)) {
			console.log('wrong message format');
			return;
		}

		let deviceId = data.readUInt16LE(Messages.BUFFER_INDEX_EXT_MSG_BEGIN + 1);
		let deviceType = data.readUInt8(Messages.BUFFER_INDEX_EXT_MSG_BEGIN + 3);

		if (deviceType !== SpeedScanner.deviceType) {
			return;
		}

		if (!this.states[deviceId]) {
			this.states[deviceId] = new SpeedScanState(deviceId);
		}

		if (data.readUInt8(Messages.BUFFER_INDEX_EXT_MSG_BEGIN) & 0x40) {
			if (data.readUInt8(Messages.BUFFER_INDEX_EXT_MSG_BEGIN + 5) === 0x20) {
				this.states[deviceId].Rssi = data.readInt8(Messages.BUFFER_INDEX_EXT_MSG_BEGIN + 6);
				this.states[deviceId].Threshold = data.readInt8(Messages.BUFFER_INDEX_EXT_MSG_BEGIN + 7);
			}
		}

		switch (data.readUInt8(Messages.BUFFER_INDEX_MSG_TYPE)) {
			case Constants.MESSAGE_CHANNEL_BROADCAST_DATA:
				updateState(this, this.states[deviceId], data);
				break;
			default:
				break;
		}
	}
}
