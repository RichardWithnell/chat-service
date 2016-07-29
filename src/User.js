
const ChatServiceError = require('./ChatServiceError')
const CommandBinder = require('./CommandBinder')
const DirectMessaging = require('./DirectMessaging')
const Promise = require('bluebird')
const UserAssociations = require('./UserAssociations')
const _ = require('lodash')
const { asyncLimit, checkNameSymbols } = require('./utils')
const { mixin } = require('es6-mixin')

// Client commands implementation.
class User {

  constructor (server, userName) {
    this.server = server
    this.userName = userName
    this.echoChannel = `echo:${this.userName}`
    this.state = this.server.state
    this.transport = this.server.transport
    this.enableUserlistUpdates = this.server.enableUserlistUpdates
    this.enableAccessListsUpdates = this.server.enableAccessListsUpdates
    this.enableRoomsManagement = this.server.enableRoomsManagement
    this.enableDirectMessages = this.server.enableDirectMessages
    this.directMessaging = new DirectMessaging(server, userName)
    let State = this.server.state.UserState
    this.userState = new State(this.server, this.userName)
    this.commandBinder =
      new CommandBinder(this.server, this.transport, this.userName)
    let opts = {
      busAckTimeout: this.server.busAckTimeout,
      clusterBus: this.server.clusterBus,
      consistencyFailure: this.consistencyFailure.bind(this),
      echoChannel: this.echoChannel,
      enableUserlistUpdates: this.enableUserlistUpdates,
      lockTTL: this.state.lockTTL,
      state: this.state,
      transport: this.transport,
      userName: this.userName,
      userState: this.userState
    }
    mixin(this, UserAssociations, opts)
  }

  initState (state) {
    return this.directMessaging.initState(state)
  }

  removeState () {
    return this.directMessaging.removeState()
  }

  processMessage (msg, setTimestamp = false) {
    delete msg.id
    delete msg.timestamp
    if (setTimestamp) {
      msg.timestamp = _.now()
    }
    msg.author = this.userName || msg.author
    return msg
  }

  exec (command, options, args) {
    let { id } = options
    let requestsNames = this.server.rpcRequestsNames
    if (!_.includes(requestsNames, command)) {
      let error = new ChatServiceError('noCommand', command)
      return Promise.reject(error)
    }
    let requiresSocket = command === 'roomJoin' || command === 'roomLeave'
    if (!id && requiresSocket) {
      let error = new ChatServiceError('noSocket', command)
      return Promise.reject(error)
    }
    let fn = this[command].bind(this)
    let cmd = this.commandBinder.makeCommand(command, fn)
    return Promise.fromCallback(
      cb => cmd(args, options, cb),
      {multiArgs: true})
  }

  checkOnline () {
    return this.userState.getAllSockets().then(sockets => {
      if (!sockets || !sockets.length) {
        let error = new ChatServiceError('noUserOnline', this.userName)
        return Promise.reject(error)
      } else {
        return Promise.resolve()
      }
    })
  }

  consistencyFailure (error, operationInfo) {
    operationInfo.userName = this.userName
    let name = operationInfo.opType === 'transportChannel'
          ? 'transportConsistencyFailure'
          : 'storeConsistencyFailure'
    this.server.emit(name, error, operationInfo)
  }

  registerSocket (id) {
    return this.state.addSocket(id, this.userName)
      .then(() => this.userState.addSocket(id, this.server.instanceUID))
      .then(nconnected => {
        if (!this.transport.getSocket(id)) {
          return this.removeUserSocket(id).then(() => {
            let error = new ChatServiceError('noSocket', 'connection')
            return Promise.reject(error)
          })
        } else {
          let commands = this.server.rpcRequestsNames
          for (let cmd of commands) {
            this.commandBinder.bindCommand(id, cmd, this[cmd].bind(this))
          }
          this.commandBinder.bindDisconnect(id, this.removeSocket.bind(this))
          return this.transport.joinChannel(id, this.echoChannel).then(() => {
            this.socketConnectEcho(id, nconnected)
            return Promise.resolve()
          })
        }
      })
  }

  removeSocket (id) {
    return this.removeSocketFromServer(id)
  }

  disconnectInstanceSockets () {
    return this.userState.getAllSockets().then(sockets => {
      return Promise.map(
        sockets,
        sid => this.transport.disconnectSocket(sid),
        { concurrency: asyncLimit })
    })
  }

  directAddToList (listName, values) {
    return this.directMessaging.addToList(this.userName, listName, values)
      .return()
  }

  directGetAccessList (listName) {
    return this.directMessaging.getList(this.userName, listName)
  }

  directGetWhitelistMode () {
    return this.directMessaging.getMode(this.userName)
  }

  directMessage (recipientName, msg, {id, bypassPermissions}) {
    if (!this.enableDirectMessages) {
      let error = new ChatServiceError('notAllowed')
      return Promise.reject(error)
    }
    this.processMessage(msg, true)
    return this.server.state.getUser(recipientName).then(recipient => {
      let channel = recipient.echoChannel
      return recipient.directMessaging
        .message(this.userName, msg, bypassPermissions)
        .then(() => recipient.checkOnline())
        .then(() => {
          this.transport.emitToChannel(channel, 'directMessage', msg)
          this.transport.sendToChannel(
            id, this.echoChannel, 'directMessageEcho', recipientName, msg)
          return msg
        })
    })
  }

  directRemoveFromList (listName, values) {
    return this.directMessaging.removeFromList(this.userName, listName, values)
      .return()
  }

  directSetWhitelistMode (mode) {
    return this.directMessaging.changeMode(this.userName, mode).return()
  }

  listOwnSockets () {
    return this.userState.getSocketsToRooms()
  }

  roomAddToList (roomName, listName, values, {bypassPermissions}) {
    return this.state.getRoom(roomName).then(room => {
      return room.addToList(this.userName, listName, values, bypassPermissions)
    }).then(userNames => {
      if (this.enableAccessListsUpdates) {
        this.transport.emitToChannel(
          roomName, 'roomAccessListAdded', roomName, listName, values)
      }
      return this.removeRoomUsers(roomName, userNames).return()
    })
  }

  roomCreate (roomName, whitelistOnly, {bypassPermissions}) {
    if (!this.enableRoomsManagement && !bypassPermissions) {
      let error = new ChatServiceError('notAllowed')
      return Promise.reject(error)
    }
    let owner = this.userName
    return checkNameSymbols(roomName)
      .then(() => this.state.addRoom(roomName, {owner, whitelistOnly}))
      .return()
  }

  roomDelete (roomName, {bypassPermissions}) {
    if (!this.enableRoomsManagement && !bypassPermissions) {
      let error = new ChatServiceError('notAllowed')
      return Promise.reject(error)
    }
    return this.state.getRoom(roomName).then(room => {
      return room.checkIsOwner(this.userName, bypassPermissions)
        .then(() => room.startRemoving())
        .then(() => room.getUsers())
        .then(userNames => this.removeRoomUsers(roomName, userNames))
        .then(() => this.state.removeRoom(roomName))
        .then(() => room.removeState())
        .return()
    })
  }

  roomGetAccessList (roomName, listName, {bypassPermissions}) {
    return this.state.getRoom(roomName)
      .then(room => room.getList(this.userName, listName, bypassPermissions))
  }

  roomGetOwner (roomName, {bypassPermissions}) {
    return this.state.getRoom(roomName)
      .then(room => room.getOwner(this.userName, bypassPermissions))
  }

  roomGetWhitelistMode (roomName, {bypassPermissions}) {
    return this.state.getRoom(roomName)
      .then(room => room.getMode(this.userName, bypassPermissions))
  }

  roomRecentHistory (roomName, {bypassPermissions}) {
    return this.state.getRoom(roomName)
      .then(room => room.getRecentMessages(this.userName, bypassPermissions))
  }

  roomHistoryGet (roomName, msgid, limit, {bypassPermissions}) {
    return this.state.getRoom(roomName)
      .then(room => room.getMessages(
        this.userName, msgid, limit, bypassPermissions))
  }

  roomHistoryInfo (roomName, {bypassPermissions}) {
    return this.state.getRoom(roomName)
      .then(room => room.getHistoryInfo(this.userName, bypassPermissions))
  }

  roomJoin (roomName, {id, isLocalCall}) {
    return this.state.getRoom(roomName)
      .then(room => this.joinSocketToRoom(id, roomName, isLocalCall))
  }

  roomLeave (roomName, {id, isLocalCall}) {
    return this.state.getRoom(roomName)
      .then(room => this.leaveSocketFromRoom(id, room.roomName, isLocalCall))
  }

  roomMessage (roomName, msg, {bypassPermissions}) {
    return this.state.getRoom(roomName).then(room => {
      this.processMessage(msg)
      return room.message(this.userName, msg, bypassPermissions)
    }).then(pmsg => {
      this.transport.emitToChannel(roomName, 'roomMessage', roomName, pmsg)
      return pmsg.id
    })
  }

  roomRemoveFromList (roomName, listName, values, {bypassPermissions}) {
    return this.state.getRoom(roomName).then(room => {
      return room.removeFromList(
        this.userName, listName, values, bypassPermissions)
    }).then(userNames => {
      if (this.enableAccessListsUpdates) {
        this.transport.emitToChannel(
          roomName, 'roomAccessListRemoved', roomName, listName, values)
      }
      return this.removeRoomUsers(roomName, userNames)
    }).return()
  }

  roomSetWhitelistMode (roomName, mode, {bypassPermissions}) {
    return this.state.getRoom(roomName).then(room => {
      return room.changeMode(this.userName, mode, bypassPermissions)
    }).spread((userNames, mode) => {
      if (this.enableAccessListsUpdates) {
        this.transport.emitToChannel(
          roomName, 'roomModeChanged', roomName, mode)
      }
      return this.removeRoomUsers(roomName, userNames)
    })
  }

  roomUserSeen (roomName, userName, {bypassPermissions}) {
    return this.state.getRoom(roomName)
      .then(room => room.userSeen(this.userName, userName, bypassPermissions))
  }

  systemMessage (data, {id}) {
    this.transport.sendToChannel(id, this.echoChannel, 'systemMessage', data)
    return Promise.resolve()
  }

}

module.exports = User