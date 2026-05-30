const EventEmitter = require("events");
const noble = require("@stoprocent/noble");
const { Parser, EventTypes, SERVICE_DATA_UUID } = require("./parser");

const ACTIVE_READ_TIMEOUT = 5000;
const ACTIVE_READ_THROTTLE = 30000;
const LYWSD03MMC_PRODUCT_ID = 1371;
const LYWSD03MMC_DATA_SERVICE_UUID = "ebe0ccb07a0a4b0c8a1a6ff2997da3a6";
const LYWSD03MMC_DATA_CHARACTERISTIC_UUID = "ebe0ccc17a0a4b0c8a1a6ff2997da3a6";

class Scanner extends EventEmitter {
  constructor(address, options) {
    super();
    options = options || {};
    const {
      log = console,
      forceDiscovering = true,
      restartDelay = 2500,
      bindKey = null,
    } = options;
    this.log = log;
    this.address = address;
    this.forceDiscovering = forceDiscovering;
    this.restartDelay = restartDelay;
    this.bindKey = bindKey;
    this.activeReadAt = new Map();
    this.activeReads = new Map();

    this.scanning = false;
    this.configure();
  }

  configure() {
    noble.on("discover", this.onDiscover.bind(this));
    noble.on("scanStart", this.onScanStart.bind(this));
    noble.on("scanStop", this.onScanStop.bind(this));
    noble.on("warning", this.onWarning.bind(this));
    noble.on("stateChange", this.onStateChange.bind(this));
  }

  start() {
    this.log.debug("Start scanning.");
    try {
      noble.startScanning([], true);
      this.scanning = true;
    } catch (e) {
      this.scanning = false;
      this.log.error(e);
    }
  }

  stop() {
    this.scanning = false;
    noble.stopScanning();
  }

  onStateChange(state) {
    if (state === "poweredOn") {
      this.start();
    } else {
      this.log.info(`Stop scanning. (${state})`);
      this.stop();
    }
  }

  onWarning(message) {
    this.log.info("Warning: ", message);
  }

  onScanStart() {
    this.log.debug("Started scanning.");
  }

  onScanStop() {
    this.log.debug("Stopped scanning.");
    // We are scanning but something stopped it. Restart scan.
    if (this.scanning && this.forceDiscovering) {
      setTimeout(() => {
        this.log.debug("Restarting scan.");
        this.start();
      }, this.restartDelay);
    }
  }

  onDiscover(peripheral) {
    const {
      advertisement: { serviceData } = {},
      id,
      address,
    } = peripheral || {};

    if (!this.isValidAddress(address) && !this.isValidAddress(id)) {
      return;
    }

    const miServiceData = this.getValidServiceData(serviceData);
    if (!miServiceData) {
      return;
    }

    this.logPeripheral({ peripheral, serviceData: miServiceData });

    const result = this.parseServiceData(miServiceData.data);
    if (result == null) {
      return;
    }

    if (!result.frameControl.hasEvent) {
      if (this.shouldUseActiveRead(result, peripheral)) {
        this.triggerActiveRead(peripheral);
        return;
      }
      this.log.debug("No event");
      return;
    }

    const { eventType, event } = result;
    switch (eventType) {
      case EventTypes.temperature: {
        const { temperature } = event;
        this.emit("temperatureChange", temperature, { id, address });
        break;
      }
      case EventTypes.humidity: {
        const { humidity } = event;
        this.emit("humidityChange", humidity, { id, address });
        break;
      }
      case EventTypes.battery: {
        const { battery } = event;
        this.emit("batteryChange", battery, { id, address });
        break;
      }
      case EventTypes.temperatureAndHumidity: {
        const { temperature, humidity } = event;
        this.emit("temperatureChange", temperature, { id, address });
        this.emit("humidityChange", humidity, { id, address });
        break;
      }
      case EventTypes.illuminance: {
        const { illuminance } = event;
        this.emit("illuminanceChange", illuminance, { id, address });
        break;
      }
      case EventTypes.moisture: {
        const { moisture } = event;
        this.emit("moistureChange", moisture, { id, address });
        break;
      }
      case EventTypes.fertility: {
        const { fertility } = event;
        this.emit("fertilityChange", fertility, { id, address });
        break;
      }
      default: {
        this.emit("error", new Error(`Unknown event type ${eventType}`));
        return;
      }
    }
    this.emit("change", event, { id, address });
  }

  cleanAddress(address) {
    if (address == null) {
      return address;
    }
    return address.toLowerCase().replace(/[:-]/g, "");
  }

  isValidAddress(address) {
    return (
      this.address == null ||
      this.cleanAddress(this.address) === this.cleanAddress(address)
    );
  }

  getValidServiceData(serviceData) {
    return (
      serviceData &&
      serviceData.find((data) => data.uuid.toLowerCase() === SERVICE_DATA_UUID)
    );
  }

  parseServiceData(serviceData) {
    try {
      return new Parser(serviceData, this.bindKey).parse();
    } catch (error) {
      this.emit("error", error);
    }
  }

  shouldUseActiveRead(result, peripheral) {
    return (
      result != null &&
      result.productId === LYWSD03MMC_PRODUCT_ID &&
      result.frameControl != null &&
      result.frameControl.hasEvent === false &&
      peripheral != null &&
      typeof peripheral.connectAsync === "function" &&
      typeof peripheral.discoverSomeServicesAndCharacteristicsAsync ===
        "function" &&
      typeof peripheral.disconnectAsync === "function"
    );
  }

  triggerActiveRead(peripheral) {
    const key = this.getPeripheralKey(peripheral);
    if (key == null) {
      return;
    }

    const activeReadStartedAt = this.activeReadAt.get(key);
    if (
      this.activeReads.has(key) ||
      (activeReadStartedAt != null &&
        activeReadStartedAt + ACTIVE_READ_THROTTLE > Date.now())
    ) {
      return;
    }

    this.activeReadAt.set(key, Date.now());
    this.log.debug(
      `[${peripheral.address || peripheral.id}] No event in advertisement. ` +
        "Reading value over GATT."
    );

    const activeRead = this.readLywsd03mmcData(peripheral)
      .then((event) => {
        const payload = {
          address: peripheral.address,
          id: peripheral.id,
        };
        this.emit("temperatureChange", event.temperature, payload);
        this.emit("humidityChange", event.humidity, payload);
        this.emit("change", event, payload);
      })
      .catch((error) => {
        this.emit("error", error);
      })
      .finally(() => {
        this.activeReads.delete(key);
      });

    this.activeReads.set(key, activeRead);
  }

  async readLywsd03mmcData(peripheral) {
    await peripheral.connectAsync();
    try {
      const { characteristics = [] } =
        await peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [LYWSD03MMC_DATA_SERVICE_UUID],
          [LYWSD03MMC_DATA_CHARACTERISTIC_UUID]
        );
      const [characteristic] = characteristics;
      if (characteristic == null) {
        throw new Error("LYWSD03MMC data characteristic was not found.");
      }

      const data = await this.readActiveCharacteristic(characteristic);
      return this.parseLywsd03mmcData(data);
    } finally {
      await peripheral.disconnectAsync();
    }
  }

  async readActiveCharacteristic(characteristic) {
    let timeoutId;
    const dataPromise = new Promise((resolve, reject) => {
      const onData = (data) => {
        clearTimeout(timeoutId);
        characteristic.removeListener("data", onData);
        resolve(data);
      };

      timeoutId = setTimeout(() => {
        characteristic.removeListener("data", onData);
        reject(new Error("Timed out waiting for LYWSD03MMC data."));
      }, ACTIVE_READ_TIMEOUT);

      characteristic.once("data", onData);
    });

    try {
      await characteristic.subscribeAsync();
      return await dataPromise;
    } finally {
      clearTimeout(timeoutId);
      if (typeof characteristic.unsubscribeAsync === "function") {
        try {
          await characteristic.unsubscribeAsync();
        } catch (error) {
          this.log.debug(error);
        }
      }
    }
  }

  parseLywsd03mmcData(data) {
    if (data == null || data.length < 5) {
      throw new Error("LYWSD03MMC data must be at least 5 bytes long.");
    }

    return {
      temperature: data.readInt16LE(0) / 100,
      humidity: data.readUInt8(2),
      batteryMv: data.readUInt16LE(3),
    };
  }

  getPeripheralKey({ address, id } = {}) {
    return this.cleanAddress(address) || this.cleanAddress(id);
  }

  logPeripheral({
    peripheral: {
      address,
      id,
      rssi,
      advertisement: { localName },
    },
    serviceData,
  }) {
    this.log.debug(`[${address || id}] Discovered peripheral
      Id: ${id}
      LocalName: ${localName}
      rssi: ${rssi}
      serviceData: ${serviceData.data.toString("hex")}`);
  }
}

module.exports = { Scanner };
